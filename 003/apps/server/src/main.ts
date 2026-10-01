import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app";
import { openDb } from "./db";
import { Hub } from "./hub";
import { startPrintWorker } from "./printing/queue";
import { tcpTransport } from "./printing/transport";
import { createBackup } from "./routes/reports";
import { syncWithHq } from "./routes/cloud";
import { startWebhookWorker } from "./webhooks";

const file = process.env.DB_FILE ?? "data/003.sqlite";
const backupDir = process.env.BACKUP_DIR ?? resolve(dirname(file), "backups");
mkdirSync(dirname(file), { recursive: true });

const db = await openDb(file);
const hub = new Hub();
const webDir = process.env.WEB_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
const isHq = process.env.ROLE === "hq";
const http = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => fetch(url, init);
const photosDir = process.env.PHOTOS_DIR ?? resolve(dirname(file), "photos");
const app = buildApp(db, { hub, backupDir, webDir, photosDir, http, hq: isHq ? { adminToken: process.env.HQ_ADMIN_TOKEN } : false });

startPrintWorker(db, tcpTransport, hub);
startWebhookWorker(db, (url, init) => fetch(url, init));

// Backup automático cada 24 h (y uno al arrancar); se conservan los últimos 14
const DAY = 24 * 60 * 60 * 1000;
const backup = () => createBackup(db, backupDir).catch((e) => console.error("Backup falló:", e));
void backup();
setInterval(backup, DAY).unref();

// Sincronización con la nube cada hora si la sucursal está vinculada; sin Internet simplemente se reintenta después
if (!isHq) {
  const sync = () => syncWithHq(db, http).catch(() => undefined);
  setTimeout(sync, 30_000).unref();
  setInterval(sync, 60 * 60 * 1000).unref();
}

const port = Number(process.env.PORT ?? 3003);
await app.listen({ port, host: process.env.HOST ?? "0.0.0.0" });
console.log(`003 ${isHq ? "HQ" : "server"} escuchando en el puerto ${port}${isHq ? "" : " (accesible desde la red local)"}`);
