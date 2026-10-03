import { randomBytes } from "node:crypto";
import { createReadStream, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createBackupBundle } from "./backup-bundle";
import { formatRecoveryKey, newRecoveryKey } from "./backup-crypto";
import type { Db } from "./db";

/** Subida de un archivo al HQ. Inyectable: las pruebas la hacen en memoria; en producción es `streamUpload`. */
export type Uploader = (
  url: string,
  init: { method: "PUT"; headers: Record<string, string>; file: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Envía el archivo como flujo (sin cargarlo en memoria) con `fetch`. */
export const streamUpload: Uploader = async (url, init) => {
  const size = statSync(init.file).size;
  const res = await fetch(url, {
    method: init.method,
    headers: { ...init.headers, "content-length": String(size) },
    body: Readable.toWeb(createReadStream(init.file)) as unknown as BodyInit,
    // @ts-expect-error: `duplex` es necesario para cuerpos en flujo y aún no está en los tipos de DOM
    duplex: "half",
  });
  return { ok: res.ok, status: res.status, json: () => res.json() };
};

const get = async (db: Db, key: string) =>
  (
    (await db.prepare("SELECT value FROM settings WHERE key=?").get(key)) as
      | { value: string }
      | undefined
  )?.value;
const put = (db: Db, key: string, value: string) =>
  db
    .prepare(
      "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(key, value);
const del = (db: Db, key: string) => db.prepare("DELETE FROM settings WHERE key=?").run(key);

/** Clave de recuperación de este local (se crea la primera vez). Vive en la base del local; el HQ nunca la ve. */
export async function ensureRecoveryKey(db: Db): Promise<Buffer> {
  const existing = await get(db, "backup_key");
  if (existing) return Buffer.from(existing, "base64");
  const key = newRecoveryKey();
  await put(db, "backup_key", key.toString("base64"));
  return key;
}
export const recoveryKeyText = async (db: Db) => formatRecoveryKey(await ensureRecoveryKey(db));

export interface CloudBackupStatus {
  linked: boolean;
  /** Ya se creó la clave de recuperación. */
  keyCreated: boolean;
  /** La persona confirmó haber guardado la clave. */
  keyConfirmed: boolean;
  lastOk: number | null;
  lastAttempt: number | null;
  lastName: string | null;
  lastSize: number | null;
  /** Último error (código y mensaje), o null si el último intento salió bien. */
  lastError: { code: string; message: string } | null;
  failures: number;
}

export async function cloudBackupStatus(db: Db): Promise<CloudBackupStatus> {
  const n = async (k: string) => {
    const v = await get(db, k);
    return v ? Number(v) : null;
  };
  const err = await get(db, "cb_last_error");
  return {
    linked: !!(await get(db, "hq_url")) && !!(await get(db, "hq_key")),
    keyCreated: !!(await get(db, "backup_key")),
    keyConfirmed: (await get(db, "backup_key_confirmed")) === "1",
    lastOk: await n("cb_last_ok"),
    lastAttempt: await n("cb_last_attempt"),
    lastName: (await get(db, "cb_last_name")) ?? null,
    lastSize: await n("cb_last_size"),
    lastError: err ? (JSON.parse(err) as { code: string; message: string }) : null,
    failures: (await n("cb_failures")) ?? 0,
  };
}

const stamp = (d = new Date()) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "-");

export interface CloudBackupDeps {
  upload: Uploader;
  /** Carpeta de fotos de platillos (se incluye en el respaldo). */
  photosDir?: string;
  /** Carpeta de trabajo para armar el paquete antes de subirlo. */
  workDir: string;
  /** Huella de este equipo (el HQ solo recibe respaldos del equipo activado). */
  fingerprint: string | null;
}

export type CloudBackupResult =
  | { ok: true; name: string; size: number }
  | { ok: false; code: string; message: string };

/**
 * Arma el respaldo cifrado y lo sube. Nunca lanza: un fallo (sin Internet, cuota, HQ caído) queda en el estado visible
 * y no afecta la operación del local (I4.2).
 */
export async function runCloudBackup(db: Db, deps: CloudBackupDeps): Promise<CloudBackupResult> {
  const url = await get(db, "hq_url");
  const branchKey = await get(db, "hq_key");
  const fail = async (code: string, message: string): Promise<CloudBackupResult> => {
    await put(db, "cb_last_error", JSON.stringify({ code, message }));
    await put(db, "cb_failures", String(((await cloudBackupStatus(db)).failures ?? 0) + 1));
    return { ok: false, code, message };
  };
  await put(db, "cb_last_attempt", String(Date.now()));
  if (!url || !branchKey)
    return fail("sin_vincular", "Este equipo todavía no está activado con Nodo");
  const key = await ensureRecoveryKey(db);
  const name = `nodo-${stamp()}-${randomBytes(2).toString("hex")}.nbk`;
  const file = join(deps.workDir, name);
  try {
    const bundle = await createBackupBundle({
      db,
      photosDir: deps.photosDir,
      key,
      outFile: file,
      tmpDir: deps.workDir,
    });
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
      "x-branch-key": branchKey,
      "x-sha256": bundle.sha256,
    };
    if (deps.fingerprint) headers["x-device-fp"] = deps.fingerprint;
    let res: Awaited<ReturnType<Uploader>>;
    try {
      res = await deps.upload(`${url}/api/hq/backups/${name}`, { method: "PUT", headers, file });
    } catch {
      return await fail(
        "sin_conexion",
        "No se pudo contactar al servidor de Nodo; se reintentará solo",
      );
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      return await fail(
        body.error ?? `http_${res.status}`,
        body.message ?? `El servidor respondió ${res.status}`,
      );
    }
    await put(db, "cb_last_ok", String(Date.now()));
    await put(db, "cb_last_name", name);
    await put(db, "cb_last_size", String(bundle.size));
    await del(db, "cb_last_error");
    await put(db, "cb_failures", "0");
    return { ok: true, name, size: bundle.size };
  } catch (e) {
    return await fail("error_local", e instanceof Error ? e.message : String(e));
  } finally {
    rmSync(file, { force: true });
  }
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Proceso de fondo: respalda en la nube si lleva más de 24 h sin lograrlo, con espera creciente tras cada fallo
 * (1, 2, 4… hasta 60 min). Revisa cada `checkMs`.
 */
export function startCloudBackupWorker(
  db: Db,
  deps: CloudBackupDeps,
  opts: { checkMs?: number; now?: () => number } = {},
): () => void {
  const now = opts.now ?? Date.now;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const s = await cloudBackupStatus(db);
      if (!s.linked) return;
      const due = !s.lastOk || now() - s.lastOk >= DAY;
      const wait = Math.min(60, 2 ** Math.max(0, s.failures - 1)) * 60_000;
      const ready = !s.failures || !s.lastAttempt || now() - s.lastAttempt >= wait;
      if (due && ready) await runCloudBackup(db, deps);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick().catch(() => undefined), opts.checkMs ?? 10 * 60_000);
  timer.unref();
  // Una primera revisión poco después de arrancar (con el servidor ya sirviendo)
  const first = setTimeout(() => void tick().catch(() => undefined), 60_000);
  first.unref();
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}
