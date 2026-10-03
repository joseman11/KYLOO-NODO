import { hkdfSync, timingSafeEqual } from "node:crypto";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { restoreBackupBundle, fileSource } from "./backup-bundle";
import { formatRecoveryKey, newRecoveryKey, parseRecoveryKey } from "./backup-crypto";
import type { Db } from "./db";

/**
 * Servidor de reserva (plan 07, D12c): otra PC del local que copia al servidor principal cada pocos minutos y, si el
 * principal muere, se promueve a principal con un botón. Todo ocurre en la red local: sin internet ni nube.
 *
 * El emparejamiento es una clave de 256 bits (la misma presentación de 55 símbolos que la clave de recuperación). De ella
 * salen, por separado, el token con que la reserva se identifica ante el principal y la clave con que se cifra la copia:
 * el token viaja por la red, la clave de cifrado nunca.
 */
const derive = (key: Buffer, info: string) =>
  Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), `nodo-reserva:${info}`, 32));
export const standbyAuthToken = (key: Buffer) => derive(key, "auth").toString("hex");
export const standbyCipherKey = (key: Buffer) => derive(key, "cifrado");

/** Compara el token recibido con el que corresponde a la clave guardada, sin filtrar información por el tiempo. */
export function tokenMatches(header: string | undefined, key: Buffer): boolean {
  const got = /^Bearer ([0-9a-f]{64})$/.exec(header ?? "")?.[1];
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(standbyAuthToken(key));
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- Lado del servidor principal ----------

const setting = async (db: Db, k: string) =>
  (
    (await db.prepare("SELECT value FROM settings WHERE key=?").get(k)) as
      | { value: string }
      | undefined
  )?.value ?? null;
const put = (db: Db, k: string, v: string) =>
  db
    .prepare(
      "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(k, v);

export async function pairingKey(db: Db): Promise<Buffer | null> {
  const v = await setting(db, "standby_key");
  return v ? Buffer.from(v, "hex") : null;
}
export async function createPairing(db: Db): Promise<string> {
  const key = newRecoveryKey();
  await put(db, "standby_key", key.toString("hex"));
  await db.prepare("DELETE FROM settings WHERE key IN ('standby_last_seen','standby_url')").run();
  return formatRecoveryKey(key);
}
export const removePairing = (db: Db) =>
  db
    .prepare("DELETE FROM settings WHERE key IN ('standby_key','standby_last_seen','standby_url')")
    .run();
export async function noteStandbySeen(db: Db, url: string) {
  await put(db, "standby_last_seen", String(Date.now()));
  await put(db, "standby_url", url);
}
export async function standbyStatus(db: Db) {
  const [key, seen, url] = await Promise.all([
    pairingKey(db),
    setting(db, "standby_last_seen"),
    setting(db, "standby_url"),
  ]);
  return { paired: !!key, last_seen: seen ? Number(seen) : null, url };
}

// ---------- Lado del servidor de reserva ----------

export interface StandbyState {
  /** Dirección del principal, p. ej. `http://192.168.1.10:3003`. */
  primary: string;
  /** Clave de emparejamiento (55 símbolos). */
  key: string;
  /** Ya se promovió: este equipo arranca como principal. */
  promoted?: boolean;
}
const stateFile = (dataDir: string) => join(dataDir, "standby.json");
export function readStandby(dataDir: string): StandbyState | null {
  try {
    const s = JSON.parse(readFileSync(stateFile(dataDir), "utf8")) as StandbyState;
    return s.primary && s.key ? s : null;
  } catch {
    return null;
  }
}
export function writeStandby(dataDir: string, s: StandbyState | null) {
  mkdirSync(dataDir, { recursive: true });
  if (s) writeFileSync(stateFile(dataDir), JSON.stringify(s), { mode: 0o600 });
  else rmSync(stateFile(dataDir), { force: true });
}

export interface SyncDeps {
  /** Dónde se guardan la copia verificada y su estado. */
  dir: string;
  state: StandbyState;
  /** Puerto en el que atiende esta reserva (el principal lo anota para avisarlo a las tablets). */
  port: number;
  fetch?: typeof fetch;
}
export interface SyncStatus {
  last_sync: number | null;
  last_error: string | null;
  bytes: number | null;
  primary_up: boolean;
}

/**
 * Trae una copia del principal, la descifra y comprueba (integridad de SQLite) en `ready/`. Solo si todo está bien
 * reemplaza la copia anterior: una descarga a medias o dañada nunca pisa la última buena.
 */
export async function syncOnce(
  deps: SyncDeps,
): Promise<{ ok: true; bytes: number } | { ok: false; error: string }> {
  const key = parseRecoveryKey(deps.state.key);
  if (!key) return { ok: false, error: "La clave de emparejamiento no es válida" };
  const f = deps.fetch ?? fetch;
  const tmp = join(deps.dir, "descarga.nbk");
  mkdirSync(deps.dir, { recursive: true });
  try {
    const res = await f(`${deps.state.primary}/api/standby/snapshot`, {
      headers: {
        authorization: `Bearer ${standbyAuthToken(key)}`,
        "x-standby-port": String(deps.port),
      },
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!res.ok || !res.body) return { ok: false, error: `El principal respondió ${res.status}` };
    let bytes = 0;
    const counter = async function* (src: AsyncIterable<Buffer>) {
      for await (const c of src) {
        bytes += c.length;
        yield c;
      }
    };
    await pipeline(
      Readable.fromWeb(res.body as never),
      async function* (src: AsyncIterable<Buffer>) {
        yield* counter(src);
      },
      createWriteStream(tmp),
    );
    const stage = join(deps.dir, "nueva");
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    await restoreBackupBundle({
      source: fileSource(tmp),
      key: standbyCipherKey(key),
      dbFile: join(stage, "db.sqlite"),
      photosDir: join(stage, "photos"),
    });
    const ready = join(deps.dir, "lista");
    rmSync(ready, { recursive: true, force: true });
    renameSync(stage, ready);
    writeFileSync(join(deps.dir, "estado.json"), JSON.stringify({ at: Date.now(), bytes }));
    return { ok: true, bytes };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    rmSync(tmp, { force: true });
    rmSync(join(deps.dir, "nueva"), { recursive: true, force: true });
  }
}

export const lastGoodCopy = (dir: string): { at: number; bytes: number } | null => {
  try {
    if (!existsSync(join(dir, "lista", "db.sqlite"))) return null;
    return JSON.parse(readFileSync(join(dir, "estado.json"), "utf8"));
  } catch {
    return null;
  }
};

/** Deja la última copia buena como la base de este equipo (la base anterior, si la hay, se aparta; no se borra). */
export function installCopy(dir: string, dbFile: string, photosDir: string): void {
  const src = join(dir, "lista", "db.sqlite");
  if (!existsSync(src)) throw new Error("Todavía no hay una copia del principal");
  if (existsSync(dbFile)) {
    const aside = `${dbFile}.antes-de-promover-${Date.now()}`;
    renameSync(dbFile, aside);
    for (const ext of ["-wal", "-shm"])
      if (existsSync(dbFile + ext)) renameSync(dbFile + ext, aside + ext);
  }
  copyFileSync(src, dbFile);
  const photos = join(dir, "lista", "photos");
  if (existsSync(photos)) {
    mkdirSync(photosDir, { recursive: true });
    for (const f of readdirSync(photos)) copyFileSync(join(photos, f), join(photosDir, f));
  }
}

/** Prueba de que el principal sigue vivo (para no promover por error si solo hubo un tropiezo de la red). */
export async function primaryAlive(primary: string, f: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await f(`${primary}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return false;
    const j = (await r.json()) as { ok?: boolean; role?: string };
    return j.ok === true && j.role !== "standby";
  } catch {
    return false;
  }
}
