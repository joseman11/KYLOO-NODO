import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "./app";
import { startCloudBackupWorker, streamUpload } from "./cloud-backup";
import { loadConfig } from "./config";
import { noteClock } from "./license";
import { defaultHqUrl, loadLicensing } from "./licensing";
import { openDb } from "./db";
import { Hub } from "./hub";
import { Logger, RotatingLog, errorFields } from "./logging";
import { startPrintWorker } from "./printing/queue";
import { tcpTransport } from "./printing/transport";
import { syncWithHq } from "./routes/cloud";
import { createBackup, listBackups } from "./routes/reports";
import { startWebhookWorker } from "./webhooks";

// `server.mjs restore …`: recupera un local en una PC nueva desde el respaldo de la nube y termina (sin arrancar el servidor)
if (process.argv[2] === "restore") {
  const { restoreCli } = await import("./restore");
  process.exit(await restoreCli(process.argv.slice(3)));
}

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });

// Registros en archivo con rotación; en terminal también salen por pantalla
const stream = new RotatingLog({ dir: config.logDir, echo: process.stdout.isTTY });
const log = new Logger(stream, config.logLevel === "debug" ? "debug" : "info");

// Un error que nadie atrapó no debe dejar al local sin servicio a medio turno: se registra y se sigue. Una excepción
// sí detiene el proceso (su estado es dudoso) y el servicio del sistema lo reinicia.
process.on("unhandledRejection", (e) => log.error("promesa rechazada sin atender", errorFields(e)));
process.on("uncaughtException", (e) => {
  log.error("excepción no capturada: el proceso se reinicia", errorFields(e));
  process.exit(1);
});

log.info("arrancando", {
  version: config.version,
  node: process.version,
  role: config.role,
  dataDir: config.dataDir,
});

const db = await openDb(config.dbFile, {
  backupDir: config.backupDir,
  onPreMigrationBackup: (file, pending) =>
    log.warn("copia de la base antes de migrar", { file, migraciones: pending }),
});
const licensing = await loadLicensing();
log.info("licencia", {
  modo: licensing.mode,
  huella: licensing.fingerprint ? `${licensing.fingerprint.slice(0, 8)}…` : null,
});
const hub = new Hub();
const isHq = config.role === "hq";
const http = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => fetch(url, init);
const app = buildApp(db, {
  hub,
  backupDir: config.backupDir,
  webDir: config.webDir,
  photosDir: config.photosDir,
  http,
  hq: isHq ? { adminToken: process.env.HQ_ADMIN_TOKEN } : false,
  licensing,
  hqUrl: defaultHqUrl(),
  logger: { stream, level: config.logLevel },
  version: config.version,
});

const stopPrint = startPrintWorker(db, tcpTransport, hub);
// Respaldo cifrado en la nube (solo un local vinculado; el HQ no se respalda a sí mismo)
const stopCloudBackup = isHq
  ? () => undefined
  : startCloudBackupWorker(db, {
      upload: streamUpload,
      photosDir: config.photosDir,
      workDir: join(config.backupDir, ".trabajo"),
      fingerprint: licensing.fingerprint,
    });
const stopWebhooks = startWebhookWorker(db, (url, init) => fetch(url, init));

// Backup automático cada 24 h (y uno al arrancar); se conservan los últimos 14
const DAY = 24 * 60 * 60 * 1000;
const backup = () =>
  createBackup(db, config.backupDir).then(
    (name) => log.info("respaldo automático", { name }),
    (e) => log.error("el respaldo automático falló", errorFields(e)),
  );
// Al arrancar solo se respalda si el último automático tiene más de 12 h: un servicio que se reinicia en bucle
// no debe desplazar con copias idénticas las que sí sirven
const last = listBackups(config.backupDir).find((b) => b.file.startsWith("003-"));
if (!last || Date.now() - last.created_at > 12 * 60 * 60 * 1000) void backup();
const backupTimer = setInterval(backup, DAY);
backupTimer.unref();

// Sincronización con la nube cada hora si la sucursal está vinculada; sin Internet simplemente se reintenta después
const timers: NodeJS.Timeout[] = [backupTimer];
if (!isHq) {
  const sync = () => syncWithHq(db, http, licensing).catch(() => undefined);
  timers.push(setTimeout(sync, 30_000).unref(), setInterval(sync, 60 * 60 * 1000).unref());
}

// Marca de la hora más alta vista: retrasar el reloj no alarga una licencia (plan 03, D3.6)
const clockTimer = setInterval(() => void noteClock(db).catch(() => undefined), 10 * 60 * 1000);
clockTimer.unref();
timers.push(clockTimer);
void noteClock(db).catch(() => undefined);

await app.listen({ port: config.port, host: config.host });
log.info("escuchando", { port: config.port, host: config.host });

// Apagado ordenado: deja de aceptar peticiones, termina las que van y cierra la base (el WAL queda consolidado)
let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  log.info("apagando", { signal });
  // Si algo se queda colgado (una conexión abierta), no se espera para siempre
  setTimeout(() => process.exit(1), 10_000).unref();
  stopPrint();
  stopCloudBackup();
  stopWebhooks();
  for (const t of timers) clearTimeout(t);
  try {
    await app.close();
    await db.close();
    log.info("apagado completo");
    process.exit(0);
  } catch (e) {
    log.error("el apagado falló", errorFields(e));
    process.exit(1);
  }
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void shutdown(signal));
