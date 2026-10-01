import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { MIGRATIONS } from "./schema";

export type Db = Database.Database;

export function openDb(file: string): Db {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
  const applied = new Set(db.prepare("SELECT id FROM schema_migrations").all().map((r) => (r as { id: number }).id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    // Reconstruir tablas exige desactivar las claves foráneas fuera de la transacción (procedimiento oficial de SQLite)
    if (m.rebuild) db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(m.sql);
        if (m.rebuild) {
          const bad = db.pragma("foreign_key_check") as unknown[];
          if (bad.length) throw new Error(`Migración ${m.id}: claves foráneas rotas`);
        }
        db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?,?,?)").run(m.id, m.name, Date.now());
      })();
    } finally {
      if (m.rebuild) db.pragma("foreign_keys = ON");
    }
  }
}

export function newId(): string {
  return randomBytes(12).toString("hex");
}

/** Secreto JWT persistido en la base de datos, generado en el primer arranque. */
export function jwtSecret(db: Db): string {
  const row = db.prepare("SELECT value FROM settings WHERE key='jwt_secret'").get() as { value: string } | undefined;
  if (row) return row.value;
  const secret = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO settings (key, value) VALUES ('jwt_secret', ?)").run(secret);
  return secret;
}

export function audit(
  db: Db,
  userId: string | null,
  action: string,
  entity?: string,
  entityId?: string,
  detail?: unknown,
): void {
  db.prepare("INSERT INTO audit_log (ts, user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?)").run(
    Date.now(),
    userId,
    action,
    entity ?? null,
    entityId ?? null,
    detail === undefined ? null : JSON.stringify(detail),
  );
}
