import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { decryptStream, encryptStream } from "./backup-crypto";
import type { Db } from "./db";
import { SqliteDb } from "./store/sqlite";

/**
 * Paquete de respaldo (plan 04): una instantánea consistente de la base y las fotos de platillos, en un contenedor sin
 * dependencias que luego se cifra (`backup-crypto.ts`). Contenido en claro:
 *
 *   "NODOPK1\0"  y, por cada archivo:  nombre (u16 + UTF-8) | tamaño (u64) | bytes   ...  nombre de largo 0 = fin
 *
 * Los nombres válidos son `db.sqlite` y `photos/<archivo>`; al restaurar se rechaza cualquier otro (no se escribe fuera
 * de la carpeta de destino aunque el paquete sea malicioso).
 */
const PK_MAGIC = Buffer.from("NODOPK1\0");
const DB_ENTRY = "db.sqlite";

interface Entry {
  name: string;
  path: string;
}

async function* pack(entries: Entry[]) {
  yield PK_MAGIC;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const head = Buffer.alloc(2 + name.length + 8);
    head.writeUInt16BE(name.length, 0);
    name.copy(head, 2);
    head.writeBigUInt64BE(BigInt(statSync(e.path).size), 2 + name.length);
    yield head;
    for await (const chunk of createReadStream(e.path)) yield chunk as Buffer;
  }
  yield Buffer.alloc(2);
}

export interface BundleInfo {
  file: string;
  size: number;
  sha256: string;
  files: number;
}

/** Arma el respaldo cifrado de `db` y `photosDir` en `outFile`. La base se copia con la API de respaldo (consistente, sin parar el servicio). */
export async function createBackupBundle(opts: {
  db: Db;
  photosDir?: string;
  key: Buffer;
  outFile: string;
  tmpDir: string;
}): Promise<BundleInfo> {
  mkdirSync(opts.tmpDir, { recursive: true });
  mkdirSync(dirname(opts.outFile), { recursive: true });
  const snap = join(opts.tmpDir, `snap-${randomBytes(4).toString("hex")}.sqlite`);
  try {
    await opts.db.backup(snap);
    const entries: Entry[] = [{ name: DB_ENTRY, path: snap }];
    if (opts.photosDir && existsSync(opts.photosDir)) {
      for (const f of readdirSync(opts.photosDir).sort()) {
        const p = join(opts.photosDir, f);
        if (statSync(p).isFile()) entries.push({ name: `photos/${f}`, path: p });
      }
    }
    const hash = createHash("sha256");
    let size = 0;
    const encrypted = Readable.from(encryptStream(opts.key, pack(entries)));
    encrypted.on("data", (c: Buffer) => {
      hash.update(c);
      size += c.length;
    });
    await pipeline(encrypted, createWriteStream(opts.outFile));
    return { file: opts.outFile, size, sha256: hash.digest("hex"), files: entries.length };
  } finally {
    rmSync(snap, { force: true });
  }
}

const validName = (n: string) => n === DB_ENTRY || /^photos\/[^/\\]+$/.test(n);

/** Descifra y escribe los archivos del paquete en `destDir`, con sus mismos nombres. */
async function unpack(source: AsyncIterable<Buffer>, destDir: string): Promise<string[]> {
  let buf = Buffer.alloc(0);
  const it = source[Symbol.asyncIterator]();
  const fill = async (n: number) => {
    while (buf.length < n) {
      const r = await it.next();
      if (r.done) return false;
      buf = buf.length ? Buffer.concat([buf, r.value]) : r.value;
    }
    return true;
  };
  if (!(await fill(PK_MAGIC.length)) || !buf.subarray(0, PK_MAGIC.length).equals(PK_MAGIC))
    throw new Error("El respaldo no tiene el contenido esperado");
  buf = buf.subarray(PK_MAGIC.length);
  const written: string[] = [];
  for (;;) {
    if (!(await fill(2))) throw new Error("Respaldo incompleto");
    const nameLen = buf.readUInt16BE(0);
    buf = buf.subarray(2);
    if (nameLen === 0) break;
    if (!(await fill(nameLen + 8))) throw new Error("Respaldo incompleto");
    const name = buf.subarray(0, nameLen).toString("utf8");
    let remaining = Number(buf.readBigUInt64BE(nameLen));
    buf = buf.subarray(nameLen + 8);
    if (!validName(name)) throw new Error(`Nombre de archivo no permitido en el respaldo: ${name}`);
    const target = join(destDir, name);
    mkdirSync(dirname(target), { recursive: true });
    const out = createWriteStream(target);
    try {
      while (remaining > 0) {
        if (buf.length === 0 && !(await fill(1))) throw new Error("Respaldo incompleto");
        const take = Math.min(remaining, buf.length);
        if (!out.write(buf.subarray(0, take)))
          await new Promise<void>((r) => out.once("drain", () => r()));
        buf = buf.subarray(take);
        remaining -= take;
      }
    } finally {
      await new Promise<void>((r) => out.end(r));
    }
    written.push(name);
  }
  if (!written.includes(DB_ENTRY)) throw new Error("El respaldo no contiene la base de datos");
  return written;
}

export interface RestoreResult {
  dbFile: string;
  files: number;
  photos: number;
  /** Dónde quedó la base anterior si se usó `force`. */
  movedAside?: string;
}

/**
 * Restaura un respaldo cifrado en una instalación: base en `dbFile` y fotos en `photosDir`. Verifica antes de tocar nada
 * (descifrado completo con autenticación e `integrity_check` de SQLite) y **no pisa una base existente** sin `force`
 * (en ese caso la anterior se aparta, no se borra).
 */
export async function restoreBackupBundle(opts: {
  source: AsyncIterable<Buffer>;
  key: Buffer;
  dbFile: string;
  photosDir: string;
  force?: boolean;
}): Promise<RestoreResult> {
  if (existsSync(opts.dbFile) && !opts.force)
    throw new Error(
      `Ya existe una base de datos en ${opts.dbFile}. Restaurar la sobrescribiría; usa --force si es lo que quieres (la actual se aparta, no se borra).`,
    );
  const stage = join(dirname(opts.dbFile), `.restaurando-${randomBytes(4).toString("hex")}`);
  mkdirSync(stage, { recursive: true });
  try {
    const files = await unpack(decryptStream(opts.key, opts.source), stage);
    // La base restaurada debe abrirse, pasar la comprobación de integridad y traer su historial de migraciones
    const probe = new SqliteDb(join(stage, DB_ENTRY));
    try {
      const check = (await probe.prepare("PRAGMA integrity_check").get()) as {
        integrity_check: string;
      };
      if (check.integrity_check !== "ok") throw new Error("La base del respaldo está dañada");
      const m = (await probe.prepare("SELECT COUNT(*) c FROM schema_migrations").get()) as {
        c: number;
      };
      if (!m.c) throw new Error("La base del respaldo no tiene historial de migraciones");
    } finally {
      await probe.close();
    }
    let movedAside: string | undefined;
    if (existsSync(opts.dbFile)) {
      movedAside = `${opts.dbFile}.antes-de-restaurar-${Date.now()}`;
      renameSync(opts.dbFile, movedAside);
      for (const ext of ["-wal", "-shm"])
        if (existsSync(opts.dbFile + ext)) renameSync(opts.dbFile + ext, movedAside + ext);
    }
    renameSync(join(stage, DB_ENTRY), opts.dbFile);
    const photos = files.filter((f) => f.startsWith("photos/"));
    if (photos.length) {
      mkdirSync(opts.photosDir, { recursive: true });
      for (const f of photos) renameSync(join(stage, f), join(opts.photosDir, basename(f)));
    }
    return { dbFile: opts.dbFile, files: files.length, photos: photos.length, movedAside };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Lee un archivo como flujo de trozos (para `restoreBackupBundle`). */
export const fileSource = (file: string) => createReadStream(file) as AsyncIterable<Buffer>;
