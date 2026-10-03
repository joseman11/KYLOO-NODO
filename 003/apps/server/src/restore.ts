import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileSource, restoreBackupBundle } from "./backup-bundle";
import { BackupCryptoError, parseRecoveryKey } from "./backup-crypto";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { machineFingerprint } from "./fingerprint";

export interface RestoreOptions {
  hqUrl: string;
  /** Código de activación NODO-XXXX-XXXX-XXXX que emite el propietario (activa este equipo nuevo). */
  code: string;
  /** Clave de recuperación del local (la que se guardó al activar los respaldos). */
  recoveryKey: string;
  dataDir?: string;
  force?: boolean;
  /** Equipo y red inyectables para pruebas. */
  fingerprint?: string | null;
  fetchFn?: typeof fetch;
  log?: (m: string) => void;
}

export interface RestoreSummary {
  backup: string;
  files: number;
  photos: number;
  dbFile: string;
  branch?: string;
}

/**
 * Recuperación de un local en una PC nueva (plan 04, D4.5):
 *  1. activa este equipo con el código del propietario (nueva huella y llave: el equipo anterior queda fuera);
 *  2. baja el respaldo más reciente del HQ y verifica su suma;
 *  3. lo descifra con la clave de recuperación, lo verifica y lo deja en la carpeta de datos (sin pisar una base existente);
 *  4. deja la base migrada y vinculada al HQ con la licencia nueva.
 * Cualquier fallo se dice con su motivo y no deja la instalación a medias.
 */
export async function restoreFromCloud(o: RestoreOptions): Promise<RestoreSummary> {
  const log = o.log ?? (() => undefined);
  const f = o.fetchFn ?? fetch;
  const base = o.hqUrl.replace(/\/$/, "");
  const key = parseRecoveryKey(o.recoveryKey);
  if (!key)
    throw new Error(
      "La clave de recuperación no es válida (revisa que esté completa y sin errores de tecleo)",
    );
  const fp = o.fingerprint !== undefined ? o.fingerprint : await machineFingerprint();
  if (!fp) throw new Error("No se pudo identificar este equipo para activarlo");
  const cfg = loadConfig(o.dataDir ? { ...process.env, NODO_DATA_DIR: o.dataDir } : process.env);
  mkdirSync(cfg.dataDir, { recursive: true });

  // 1) activar
  log("Activando este equipo…");
  const act = await f(`${base}/api/hq/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: o.code, fingerprint: fp, device: "restauracion" }),
  }).catch(() => {
    throw new Error("No se pudo contactar al servidor de Nodo (hace falta Internet)");
  });
  const a = (await act.json().catch(() => ({}))) as {
    api_key?: string;
    token?: string;
    branch?: string;
    message?: string;
  };
  if (!act.ok || !a.api_key || !a.token)
    throw new Error(a.message ?? `No se pudo activar (HTTP ${act.status})`);
  const headers = { "x-branch-key": a.api_key, "x-device-fp": fp };

  // 2) el respaldo más reciente
  log("Buscando el respaldo más reciente…");
  const listRes = await f(`${base}/api/hq/backups`, { headers });
  if (!listRes.ok) throw new Error(`No se pudo consultar los respaldos (HTTP ${listRes.status})`);
  const list = (await listRes.json()) as { name: string; size: number; sha256: string }[];
  const latest = list[0];
  if (!latest) throw new Error("Esta sucursal no tiene respaldos en la nube");
  log(`Descargando ${latest.name} (${Math.round(latest.size / 1024)} KB)…`);
  const dl = await f(`${base}/api/hq/backups/${latest.name}`, { headers });
  if (!dl.ok || !dl.body) throw new Error(`No se pudo descargar el respaldo (HTTP ${dl.status})`);
  const tmp = join(cfg.dataDir, `.descarga-${Date.now()}.nbk`);
  try {
    await pipeline(Readable.fromWeb(dl.body as never), createWriteStream(tmp));
    const hash = createHash("sha256");
    for await (const c of createReadStream(tmp)) hash.update(c as Buffer);
    if (hash.digest("hex") !== latest.sha256)
      throw new Error("El respaldo se descargó dañado (la suma no coincide): vuelve a intentarlo");

    // 3) descifrar, verificar e instalar
    log("Descifrando y verificando…");
    let res: Awaited<ReturnType<typeof restoreBackupBundle>>;
    try {
      res = await restoreBackupBundle({
        source: fileSource(tmp),
        key,
        dbFile: cfg.dbFile,
        photosDir: cfg.photosDir,
        force: o.force,
      });
    } catch (e) {
      if (e instanceof BackupCryptoError) throw new Error(e.message);
      throw e;
    }

    // 4) migrar y vincular con la licencia nueva
    const pub = await f(`${base}/api/hq/public-key`)
      .then((r) => (r.ok ? (r.json() as Promise<{ public_key: string }>) : null))
      .catch(() => null);
    const db = await openDb(cfg.dbFile, { backupDir: cfg.backupDir });
    try {
      const set = (k: string, v: string) =>
        db
          .prepare(
            "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(k, v);
      await set("hq_url", base);
      await set("hq_key", a.api_key);
      await set("license", a.token);
      if (pub?.public_key) await set("hq_public_key", pub.public_key);
      await set("backup_key_confirmed", "1");
    } finally {
      await db.close();
    }
    return {
      backup: latest.name,
      files: res.files,
      photos: res.photos,
      dbFile: res.dbFile,
      branch: a.branch,
    };
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Interfaz de línea de comandos: `server.mjs restore --hq-url … --code … --key … [--data-dir …] [--force]`. */
export async function restoreCli(argv: string[]): Promise<number> {
  const opt = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const hqUrl = opt("hq-url") ?? process.env.NODO_HQ_URL;
  const code = opt("code");
  const recoveryKey = opt("key");
  if (!hqUrl || !code || !recoveryKey) {
    console.error(
      "Uso: restore --hq-url <https://…> --code <NODO-XXXX-XXXX-XXXX> --key <clave de recuperación> [--data-dir <carpeta>] [--force]",
    );
    return 2;
  }
  try {
    const r = await restoreFromCloud({
      hqUrl,
      code,
      recoveryKey,
      dataDir: opt("data-dir"),
      force: argv.includes("--force"),
      log: (m) => console.log(m),
    });
    console.log(
      `\nListo: se restauró «${r.backup}» (${r.files} archivos, ${r.photos} fotos) en ${r.dbFile}.\nArranca Nodo con normalidad: ya está activado y vinculado.`,
    );
    return 0;
  } catch (e) {
    console.error(`\nNo se pudo restaurar: ${(e as Error).message}`);
    return 1;
  }
}
