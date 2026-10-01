/**
 * Traducción de SQL de SQLite (el dialecto en que está escrita la aplicación) a PostgreSQL.
 * Cubre solo lo que Nodo usa; las diferencias de fondo se evitan escribiendo SQL portable en la aplicación.
 */

const cache = new Map<string, string>();

/** Formatos de strftime que Nodo usa → expresión de PostgreSQL (zona horaria de la sesión = la del restaurante). */
function strftimeToPg(fmt: string, arg: string): string {
  const ts = `to_timestamp((${arg})::double precision)`;
  switch (fmt) {
    case "%H": return `to_char(${ts}, 'HH24')`;
    case "%w": return `CAST(EXTRACT(DOW FROM ${ts}) AS TEXT)`;
    case "%Y-%m-%d": return `to_char(${ts}, 'YYYY-MM-DD')`;
    case "%Y-%m": return `to_char(${ts}, 'YYYY-MM')`;
    default: throw new Error(`strftime('${fmt}') no está soportado en PostgreSQL`);
  }
}

/** Reemplaza `?` por `$1, $2…` sin tocar los que están dentro de comillas. */
function placeholders(sql: string): string {
  let out = "";
  let n = 0;
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (quote) {
      out += c;
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
      out += c;
    } else if (c === "?") {
      out += `$${++n}`;
    } else out += c;
  }
  return out;
}

/** Consultas (SELECT/INSERT/UPDATE/DELETE) de SQLite → PostgreSQL. */
export function toPg(sql: string): string {
  const hit = cache.get(sql);
  if (hit) return hit;
  let s = sql;
  // strftime('%H', created_at/1000,'unixepoch','localtime')
  s = s.replace(/strftime\(\s*'(%[A-Za-z](?:-%[A-Za-z])*)'\s*,\s*([^,]+?)\s*,\s*'unixepoch'\s*(?:,\s*'localtime'\s*)?\)/g, (_m, fmt, arg) => strftimeToPg(fmt, arg));
  s = s.replace(/\bIS NOT \?/gi, "IS DISTINCT FROM ?");
  s = s.replace(/\? IS (NOT )?NULL/gi, "CAST(? AS TEXT) IS $1NULL").replace(/IS  NULL/g, "IS NULL");
  // LIKE de SQLite no distingue mayúsculas (ASCII); PostgreSQL sí
  s = s.replace(/\bLIKE\b/g, "ILIKE");
  s = placeholders(s);
  cache.set(sql, s);
  return s;
}

/** Tablas que no llevan columna `rowid` (tienen su propio orden de inserción). */
const NO_ROWID = new Set(["schema_migrations", "audit_log"]);

function splitTop(body: string): string[] {
  // separa por comas de primer nivel (fuera de paréntesis y comillas)
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const c of body) {
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === "'") { quote = c; cur += c; continue; }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** DDL de SQLite (tal como lo guarda sqlite_master) → PostgreSQL. */
export function ddlToPg(sql: string): string {
  let s = sql;
  s = s.replace(/\bINTEGER PRIMARY KEY AUTOINCREMENT\b/g, "BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY");
  s = s.replace(/\bINTEGER\b/g, "BIGINT").replace(/\bREAL\b/g, "DOUBLE PRECISION");
  const m = /^\s*CREATE TABLE\s+"?(\w+)"?\s*\(([\s\S]*)\)\s*;?\s*$/i.exec(s);
  if (m) {
    const [, name, body] = m as unknown as [string, string, string];
    if (!NO_ROWID.has(name)) {
      // orden de inserción estable (SQLite lo da con rowid; la aplicación ordena por él)
      s = `CREATE TABLE ${name} (\n  rowid BIGINT GENERATED ALWAYS AS IDENTITY,\n${splitTop(body).map((p) => p.replace(/^\s*\n/, "")).join(",")}\n)`;
    }
  }
  return s;
}

/** Disparadores de SQLite (solo existen los de la bitácora) → función + disparador de PostgreSQL. */
export const PG_AUDIT_TRIGGERS = `
CREATE FUNCTION audit_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit_log es append-only'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_append_only();
`;
