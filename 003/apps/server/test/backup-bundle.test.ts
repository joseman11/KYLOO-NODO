import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackupBundle, fileSource, restoreBackupBundle } from "../src/backup-bundle";
import { encryptStream } from "../src/backup-crypto";
import { openDb } from "../src/db";

let tmp: string;
const key = randomBytes(32);
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nodo-bundle-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function origin() {
  const db = await openDb(join(tmp, "origen.sqlite"));
  await db
    .prepare("INSERT INTO settings (key,value) VALUES ('establishment_name','Mariscos El Faro')")
    .run();
  const photos = join(tmp, "fotos");
  mkdirSync(photos);
  writeFileSync(join(photos, "ceviche.jpg"), randomBytes(5000));
  writeFileSync(join(photos, "tostada.jpg"), randomBytes(3000));
  return { db, photos };
}

describe("paquete de respaldo", () => {
  it("ida y vuelta: base y fotos idénticas en una carpeta nueva", async () => {
    const { db, photos } = await origin();
    const info = await createBackupBundle({
      db,
      photosDir: photos,
      key,
      outFile: join(tmp, "out", "r.nbk"),
      tmpDir: join(tmp, "work"),
    });
    expect(info.files).toBe(3);
    expect(info.size).toBeGreaterThan(8000);
    const bytes = readFileSync(info.file);
    // nada legible: ni el nombre del local ni el formato de SQLite
    expect(bytes.includes(Buffer.from("Mariscos El Faro"))).toBe(false);
    expect(bytes.includes(Buffer.from("SQLite format 3"))).toBe(false);

    const dest = join(tmp, "nuevo");
    mkdirSync(dest);
    const r = await restoreBackupBundle({
      source: fileSource(info.file),
      key,
      dbFile: join(dest, "nodo.sqlite"),
      photosDir: join(dest, "photos"),
    });
    expect(r).toMatchObject({ files: 3, photos: 2 });
    const back = await openDb(join(dest, "nodo.sqlite"));
    expect(
      await back.prepare("SELECT value FROM settings WHERE key='establishment_name'").get(),
    ).toEqual({
      value: "Mariscos El Faro",
    });
    expect(
      readFileSync(join(dest, "photos", "ceviche.jpg")).equals(
        readFileSync(join(photos, "ceviche.jpg")),
      ),
    ).toBe(true);
    await back.close();
    await db.close();
  });

  it("el respaldo es consistente aunque la base esté en uso (WAL)", async () => {
    const { db } = await origin();
    for (let i = 0; i < 200; i++)
      await db
        .prepare("INSERT INTO settings (key,value) VALUES (?,?)")
        .run(`k${i}`, "x".repeat(200));
    const info = await createBackupBundle({
      db,
      key,
      outFile: join(tmp, "r.nbk"),
      tmpDir: join(tmp, "work"),
    });
    const dest = join(tmp, "n");
    mkdirSync(dest);
    await restoreBackupBundle({
      source: fileSource(info.file),
      key,
      dbFile: join(dest, "a.sqlite"),
      photosDir: join(dest, "p"),
    });
    const back = await openDb(join(dest, "a.sqlite"));
    expect(
      ((await back.prepare("SELECT COUNT(*) c FROM settings").get()) as { c: number }).c,
    ).toBeGreaterThanOrEqual(200);
    await back.close();
    await db.close();
  });

  it("con otra clave o con el archivo alterado no restaura nada", async () => {
    const { db } = await origin();
    const info = await createBackupBundle({
      db,
      key,
      outFile: join(tmp, "r.nbk"),
      tmpDir: join(tmp, "work"),
    });
    const dest = join(tmp, "n");
    mkdirSync(dest);
    const base = { dbFile: join(dest, "a.sqlite"), photosDir: join(dest, "p") };
    await expect(
      restoreBackupBundle({ ...base, source: fileSource(info.file), key: randomBytes(32) }),
    ).rejects.toThrow(/clave no es la correcta/);
    const bad = readFileSync(info.file);
    bad[bad.length - 40] = bad[bad.length - 40]! ^ 1;
    writeFileSync(join(tmp, "malo.nbk"), bad);
    await expect(
      restoreBackupBundle({ ...base, key, source: fileSource(join(tmp, "malo.nbk")) }),
    ).rejects.toThrow();
    expect(existsSync(base.dbFile)).toBe(false);
    expect(readdirSync(dest).filter((f) => f.startsWith(".restaurando"))).toEqual([]); // sin restos
    await db.close();
  });

  it("no pisa una base existente sin --force; con él, la anterior se aparta", async () => {
    const { db } = await origin();
    const info = await createBackupBundle({
      db,
      key,
      outFile: join(tmp, "r.nbk"),
      tmpDir: join(tmp, "work"),
    });
    const dest = join(tmp, "n");
    mkdirSync(dest);
    const dbFile = join(dest, "a.sqlite");
    writeFileSync(dbFile, "base actual con ventas");
    const args = { source: fileSource(info.file), key, dbFile, photosDir: join(dest, "p") };
    await expect(restoreBackupBundle(args)).rejects.toThrow(/Ya existe una base/);
    expect(readFileSync(dbFile, "utf8")).toBe("base actual con ventas");
    const r = await restoreBackupBundle({ ...args, source: fileSource(info.file), force: true });
    expect(readFileSync(r.movedAside!, "utf8")).toBe("base actual con ventas");
    await db.close();
  });

  it("un paquete malicioso no puede escribir fuera de la carpeta", async () => {
    const evil = Buffer.concat([
      Buffer.from("NODOPK1\0"),
      (() => {
        const n = Buffer.from("../../fuera.txt");
        const h = Buffer.alloc(2 + n.length + 8);
        h.writeUInt16BE(n.length, 0);
        n.copy(h, 2);
        h.writeBigUInt64BE(3n, 2 + n.length);
        return Buffer.concat([h, Buffer.from("abc")]);
      })(),
      Buffer.alloc(2),
    ]);
    async function* src() {
      yield evil;
    }
    const out: Buffer[] = [];
    for await (const c of encryptStream(key, src())) out.push(c);
    writeFileSync(join(tmp, "evil.nbk"), Buffer.concat(out));
    const dest = join(tmp, "n");
    mkdirSync(dest);
    await expect(
      restoreBackupBundle({
        source: fileSource(join(tmp, "evil.nbk")),
        key,
        dbFile: join(dest, "a.sqlite"),
        photosDir: join(dest, "p"),
      }),
    ).rejects.toThrow(/no permitido/);
    expect(existsSync(join(tmp, "fuera.txt"))).toBe(false);
  });

  it("un respaldo sin base de datos o con una base dañada se rechaza", async () => {
    async function* nodb() {
      yield Buffer.concat([Buffer.from("NODOPK1\0"), Buffer.alloc(2)]);
    }
    const out: Buffer[] = [];
    for await (const c of encryptStream(key, nodb())) out.push(c);
    writeFileSync(join(tmp, "nodb.nbk"), Buffer.concat(out));
    const dest = join(tmp, "n");
    mkdirSync(dest);
    await expect(
      restoreBackupBundle({
        source: fileSource(join(tmp, "nodb.nbk")),
        key,
        dbFile: join(dest, "a.sqlite"),
        photosDir: join(dest, "p"),
      }),
    ).rejects.toThrow(/no contiene la base/);
  });
});
