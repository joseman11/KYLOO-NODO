import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDb } from "./db";
import { seedDemo } from "./seed-demo";

// Base y fotos propias: no toca la base de operación (data/003.sqlite)
const file = process.env.DB_FILE ?? "data/mariscos.sqlite";
const photosDir = process.env.PHOTOS_DIR ?? resolve(dirname(file), "mariscos-photos");
mkdirSync(dirname(file), { recursive: true });
if (process.argv.includes("--reset")) {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
  rmSync(photosDir, { recursive: true, force: true });
}

const db = await openDb(file);
try {
  const s = await seedDemo(db, { photosDir });
  console.log(`\n${s.establishment}: datos de demostración cargados en ${file}\n`);
  console.table(s.counts);
  console.log(`Ventas de los últimos 14 días: ${s.salesLast14Days.accounts} cuentas · $${(s.salesLast14Days.salesCents / 100).toLocaleString("es-MX")}`);
  console.log("\nAcceso:");
  for (const u of s.users) console.log(`  ${u.name.padEnd(16)} ${u.role.padEnd(8)} ${u.pin ? `PIN ${u.pin}` : `usuario ${u.username} / contraseña admin1234`}`);
  console.log(`\nPara usarla:\n  DB_FILE=${file} PHOTOS_DIR=${photosDir} PORT=3005 pnpm --filter @003/server start\n`);
} catch (e) {
  console.error((e as Error).message, "\nUsa --reset para borrar la demo anterior y volver a cargarla.");
  process.exit(1);
}
