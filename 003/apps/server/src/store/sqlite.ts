import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { Db, RunResult, Stmt } from "./types";

// ⚠️ Se carga como módulo incorporado y no con `import`: Vitest (Vite) reescribe `node:sqlite` a «sqlite» y falla.
const sqlite = process.getBuiltinModule("node:sqlite");

/** `node:sqlite` solo acepta null, números, texto y binarios: los booleanos y `undefined` se convierten como hacía better-sqlite3 con los primeros. */
const bind = (params: unknown[]) =>
  params.map((v) => (typeof v === "boolean" ? Number(v) : v === undefined ? null : v)) as (
    | null
    | number
    | string
    | Uint8Array
  )[];

interface TxCtx {
  depth: number;
}

/**
 * Motor SQLite (`node:sqlite` es síncrono): se envuelve en promesas y las transacciones se serializan.
 * Mientras una transacción está abierta, las consultas de otras solicitudes esperan su turno para no mezclarse con ella;
 * las que se hacen dentro de la transacción (mismo contexto asíncrono) pasan directo.
 */
export class SqliteDb implements Db {
  readonly dialect = "sqlite" as const;
  readonly cache: Db["cache"] = {};
  readonly raw: DatabaseSync;
  private als = new AsyncLocalStorage<TxCtx>();
  private statements = new Map<string, StatementSync>();
  /** Se resuelve cuando la transacción abierta termina (null si no hay ninguna). */
  private open: Promise<void> | null = null;

  constructor(file: string) {
    this.raw = new sqlite.DatabaseSync(file);
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA foreign_keys = ON");
  }

  private async gate() {
    // Una consulta fuera de la transacción abierta espera a que termine
    while (this.open && !this.als.getStore()) await this.open;
  }

  private stmt(sql: string) {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  prepare(sql: string): Stmt {
    return {
      get: async (...p) => {
        await this.gate();
        return this.stmt(sql).get(...bind(p));
      },
      all: async (...p) => {
        await this.gate();
        return this.stmt(sql).all(...bind(p));
      },
      run: async (...p) => {
        await this.gate();
        const r = this.stmt(sql).run(...bind(p));
        return { changes: Number(r.changes) } satisfies RunResult;
      },
    };
  }

  async exec(sql: string) {
    await this.gate();
    this.raw.exec(sql);
  }

  transaction<A extends any[], R>(fn: (...args: A) => Promise<R> | R) {
    return async (...args: A): Promise<R> => {
      const ctx = this.als.getStore();
      if (ctx) {
        // Anidada: punto de guardado
        const sp = `sp_${++ctx.depth}`;
        this.raw.exec(`SAVEPOINT ${sp}`);
        try {
          const r = await fn(...args);
          this.raw.exec(`RELEASE ${sp}`);
          return r;
        } catch (e) {
          this.raw.exec(`ROLLBACK TO ${sp}`);
          this.raw.exec(`RELEASE ${sp}`);
          throw e;
        }
      }
      while (this.open) await this.open;
      let release!: () => void;
      this.open = new Promise<void>((r) => (release = r));
      try {
        this.raw.exec("BEGIN");
        try {
          const r = await this.als.run({ depth: 0 }, () => fn(...args));
          this.raw.exec("COMMIT");
          return r;
        } catch (e) {
          if (this.raw.isTransaction) this.raw.exec("ROLLBACK");
          throw e;
        }
      } finally {
        this.open = null;
        release();
      }
    };
  }

  async backup(file: string) {
    await sqlite.backup(this.raw, file);
  }

  async close() {
    this.raw.close();
  }
}
