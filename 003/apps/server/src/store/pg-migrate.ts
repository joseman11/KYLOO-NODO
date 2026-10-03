import { loadCache, migrate } from "../db";
import { MIGRATIONS } from "../schema";
import { ddlToPg, PG_AUDIT_TRIGGERS } from "./pg-dialect";
import { dropSchema, ensureSchema, PgDb, type PgOptions } from "./pg";
import { SqliteDb } from "./sqlite";
import type { Db } from "./types";

/**
 * El esquema de PostgreSQL de un restaurante nuevo se obtiene del esquema FINAL de SQLite (así nunca se desfasan y las
 * reconstrucciones de tablas de SQLite no hacen falta). Las migraciones posteriores a esta línea base se traducen una
 * por una y deben usar solo CREATE TABLE / CREATE INDEX / ALTER TABLE … ADD COLUMN.
 */
export const PG_BASELINE_ID = 10;

interface MasterRow { type: string; name: string; tbl_name: string; sql: string | null }

const baselineCache = new Map<number, ReturnType<typeof computeFinalSchema>>();
function sqliteFinalSchema(upTo: number) {
  let p = baselineCache.get(upTo);
  if (!p) {
    p = computeFinalSchema(upTo);
    baselineCache.set(upTo, p);
  }
  return p;
}

async function computeFinalSchema(upTo: number) {
  const mem = new SqliteDb(":memory:");
  // migrate() aplica todas; para la línea base se aplican solo las ≤ upTo
  await mem.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
  for (const m of MIGRATIONS.filter((x) => x.id <= upTo)) {
    if (m.rebuild) await mem.exec("PRAGMA foreign_keys = OFF");
    await mem.exec(m.sql);
    if (m.rebuild) await mem.exec("PRAGMA foreign_keys = ON");
  }
  const rows = (await mem.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations' ORDER BY rowid").all()) as MasterRow[];
  const tables = rows.filter((r) => r.type === "table");
  const deps = new Map<string, string[]>();
  for (const t of tables) {
    const fks = (await mem.prepare(`PRAGMA foreign_key_list(${t.name})`).all()) as { table: string }[];
    deps.set(t.name, [...new Set(fks.map((f) => f.table).filter((x) => x !== t.name))]);
  }
  await mem.close();
  // orden topológico: cada tabla después de las que referencia
  const ordered: MasterRow[] = [];
  const done = new Set<string>();
  const visit = (name: string, trail: string[] = []) => {
    if (done.has(name)) return;
    if (trail.includes(name)) throw new Error(`Referencia circular entre tablas: ${[...trail, name].join(" → ")}`);
    for (const d of deps.get(name) ?? []) visit(d, [...trail, name]);
    done.add(name);
    ordered.push(tables.find((t) => t.name === name)!);
  };
  for (const t of tables) visit(t.name);
  return { tables: ordered, indexes: rows.filter((r) => r.type === "index") };
}

/**
 * Datos de partida que siembra una migración (`INSERT … VALUES`). El DDL de la línea base se toma del esquema final, pero
 * esos datos no viven ahí; las copias de reconstrucción (`INSERT INTO x_new … SELECT`) no aplican a una base vacía.
 */
export function seedInserts(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter((s) => /^INSERT INTO \w+ \([^)]*\) VALUES/i.test(s) && !/INSERT INTO \w+_new\b/i.test(s))
    .map((s) => s.replace(/lower\(hex\(randomblob\(12\)\)\)/g, "substr(replace(gen_random_uuid()::text, '-', ''), 1, 24)"));
}

/** Aplica el esquema (línea base y migraciones posteriores) al esquema de PostgreSQL de la base abierta. */
export async function migratePg(db: Db): Promise<void> {
  await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id BIGINT PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)");
  const applied = new Set(((await db.prepare("SELECT id FROM schema_migrations").all()) as { id: number }[]).map((r) => r.id));
  if (applied.size === 0) {
    const { tables, indexes } = await sqliteFinalSchema(PG_BASELINE_ID);
    await db.transaction(async () => {
      // un solo viaje a la base: todo el esquema de una vez
      await db.exec([...tables.map((t) => ddlToPg(t.sql!)), ...indexes.map((i) => ddlToPg(i.sql!)), PG_AUDIT_TRIGGERS].map((s) => s.trim().replace(/;$/, "")).join(";\n") + ";");
      for (const m of MIGRATIONS.filter((x) => x.id <= PG_BASELINE_ID)) {
        for (const stmt of seedInserts(m.sql)) await db.exec(stmt);
        await db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?,?,?)").run(m.id, m.name, Date.now());
        applied.add(m.id);
      }
    })();
  }
  for (const m of MIGRATIONS.filter((x) => x.id > PG_BASELINE_ID && !applied.has(x.id))) {
    if (m.rebuild) throw new Error(`Migración ${m.id}: las reconstrucciones de tablas no se admiten en PostgreSQL; usa ADD COLUMN / CREATE TABLE`);
    await db.transaction(async () => {
      for (const stmt of m.sql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await db.exec(ddlToPg(stmt));
      await db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?,?,?)").run(m.id, m.name, Date.now());
    })();
  }
}

/** Abre (y migra) la base de un restaurante en PostgreSQL: crea su esquema si no existe. */
export async function openPg(opts: PgOptions): Promise<Db> {
  await ensureSchema(opts.connectionString, opts.schema, opts.ssl);
  const db = new PgDb(opts);
  await migratePg(db);
  await loadCache(db);
  return db;
}

/** Base desechable para pruebas: esquema propio que se borra al cerrar. */
export async function openPgTemp(connectionString: string): Promise<Db> {
  const schema = `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const db = await openPg({ connectionString, schema });
  const close = db.close.bind(db);
  db.close = async () => {
    await close();
    await dropSchema(connectionString, schema);
  };
  return db;
}

export { migrate };
