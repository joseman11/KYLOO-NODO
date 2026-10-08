import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import type { Db, RunResult, Stmt } from "./types";
import { toPg } from "./pg-dialect";

// bigint (int8) y numeric llegan como texto: la aplicación espera números (centavos, marcas de tiempo en ms)
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export interface PgOptions {
  connectionString: string;
  /** Esquema del restaurante (todas sus tablas viven ahí). */
  schema: string;
  /** Zona horaria del restaurante (reportes por hora y día). */
  timezone?: string;
  max?: number;
  ssl?: boolean;
}

const SCHEMA_RE = /^[a-z][a-z0-9_]{0,62}$/;

interface TxCtx {
  client: pg.PoolClient;
  depth: number;
}

/**
 * Motor PostgreSQL. Cada restaurante es un esquema de la base compartida: la conexión fija `search_path`,
 * así el mismo SQL de la aplicación funciona sin conocer a qué restaurante pertenece.
 */
export class PgDb implements Db {
  readonly dialect = "pg" as const;
  readonly cache: Db["cache"] = {};
  readonly pool: pg.Pool;
  readonly schema: string;
  private als = new AsyncLocalStorage<TxCtx>();

  constructor(opts: PgOptions) {
    if (!SCHEMA_RE.test(opts.schema)) throw new Error(`Nombre de esquema inválido: ${opts.schema}`);
    this.schema = opts.schema;
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 4,
      ssl: opts.ssl ? { rejectUnauthorized: false } : undefined,
      options: `-c search_path=${opts.schema},public -c timezone=${opts.timezone ?? "America/Mexico_City"}`,
    });
  }

  private async query(sql: string, params: unknown[]) {
    const ctx = this.als.getStore();
    return (ctx?.client ?? this.pool).query(sql, params as any[]);
  }

  private clean(rows: any[]) {
    // `rowid` es solo para ordenar por inserción: no forma parte de los datos
    for (const r of rows) if (r && "rowid" in r) delete r.rowid;
    return rows;
  }

  prepare(sql: string): Stmt {
    const q = toPg(sql);
    return {
      get: async (...p) => this.clean((await this.query(q, p)).rows)[0],
      all: async (...p) => this.clean((await this.query(q, p)).rows),
      run: async (...p) => ({ changes: (await this.query(q, p)).rowCount ?? 0 }) satisfies RunResult,
    };
  }

  async exec(sql: string) {
    const ctx = this.als.getStore();
    await (ctx?.client ?? this.pool).query(sql);
  }

  transaction<A extends any[], R>(fn: (...args: A) => Promise<R> | R) {
    return async (...args: A): Promise<R> => {
      const ctx = this.als.getStore();
      if (ctx) {
        const sp = `sp_${++ctx.depth}`;
        await ctx.client.query(`SAVEPOINT ${sp}`);
        try {
          const r = await fn(...args);
          await ctx.client.query(`RELEASE SAVEPOINT ${sp}`);
          return r;
        } catch (e) {
          await ctx.client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          throw e;
        }
      }
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        // Un solo escritor por restaurante a la vez: mismo comportamiento que SQLite (folios y saldos sin carreras)
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [this.schema]);
        try {
          const r = await this.als.run({ client, depth: 0 }, () => fn(...args));
          await client.query("COMMIT");
          return r;
        } catch (e) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw e;
        }
      } finally {
        client.release();
      }
    };
  }

  async backup(): Promise<void> {
    throw new Error("En la nube los respaldos los hace el proveedor de la base de datos (pg_dump del esquema).");
  }

  async close() {
    await this.pool.end();
  }
}

/** Crea el esquema del restaurante si no existe. */
export async function ensureSchema(connectionString: string, schema: string, ssl = false) {
  if (!SCHEMA_RE.test(schema)) throw new Error(`Nombre de esquema inválido: ${schema}`);
  const c = new pg.Client({ connectionString, ssl: ssl ? { rejectUnauthorized: false } : undefined });
  await c.connect();
  try {
    await c.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  } finally {
    await c.end();
  }
}

export async function dropSchema(connectionString: string, schema: string) {
  if (!SCHEMA_RE.test(schema)) throw new Error(`Nombre de esquema inválido: ${schema}`);
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await c.end();
  }
}
