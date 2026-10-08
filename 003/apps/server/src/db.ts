import { randomBytes } from "node:crypto";
import { MIGRATIONS } from "./schema";
import { SqliteDb } from "./store/sqlite";
import type { Db } from "./store/types";

export type { Db } from "./store/types";

/** Abre (y migra) la base local de SQLite. */
export async function openDb(file: string): Promise<Db> {
  // Pruebas: con NODO_PG_URL, cada base «en memoria» es un esquema nuevo y desechable de PostgreSQL (misma suite, otro motor)
  if (file === ":memory:" && process.env.NODO_PG_URL) {
    const { openPgTemp } = await import("./store/pg-migrate");
    return openPgTemp(process.env.NODO_PG_URL);
  }
  const db = new SqliteDb(file);
  await migrate(db);
  await loadCache(db);
  return db;
}

export async function migrate(db: Db): Promise<void> {
  await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
  const applied = new Set((await db.prepare("SELECT id FROM schema_migrations").all()).map((r) => (r as { id: number }).id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    // Reconstruir tablas exige desactivar las claves foráneas fuera de la transacción (procedimiento oficial de SQLite)
    if (m.rebuild) await db.exec("PRAGMA foreign_keys = OFF");
    try {
      await db.transaction(async () => {
        await db.exec(m.sql);
        if (m.rebuild) {
          const bad = await db.prepare("PRAGMA foreign_key_check").all();
          if (bad.length) throw new Error(`Migración ${m.id}: claves foráneas rotas`);
        }
        await db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?,?,?)").run(m.id, m.name, Date.now());
      })();
    } finally {
      if (m.rebuild) await db.exec("PRAGMA foreign_keys = ON");
    }
  }
}

/** Precarga lo que se necesita de forma síncrona al construir la aplicación. */
export async function loadCache(db: Db): Promise<void> {
  db.cache.jwtSecret = await ensureJwtSecret(db);
}

export function newId(): string {
  return randomBytes(12).toString("hex");
}

async function ensureJwtSecret(db: Db): Promise<string> {
  const row = (await db.prepare("SELECT value FROM settings WHERE key='jwt_secret'").get()) as { value: string } | undefined;
  if (row) return row.value;
  const secret = randomBytes(32).toString("hex");
  await db.prepare("INSERT INTO settings (key, value) VALUES ('jwt_secret', ?)").run(secret);
  return secret;
}

/** Secreto JWT persistido en la base de datos, generado en el primer arranque (precargado por `openDb`). */
export function jwtSecret(db: Db): string {
  if (!db.cache.jwtSecret) throw new Error("La base no se abrió con openDb");
  return db.cache.jwtSecret;
}

export async function audit(
  db: Db,
  userId: string | null,
  action: string,
  entity?: string,
  entityId?: string,
  detail?: unknown,
): Promise<void> {
  await db.prepare("INSERT INTO audit_log (ts, user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?)").run(
    Date.now(),
    userId,
    action,
    entity ?? null,
    entityId ?? null,
    detail === undefined ? null : JSON.stringify(detail),
  );
}
