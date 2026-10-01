import { AsyncLocalStorage } from "node:async_hooks";
import Database from "better-sqlite3";
import type { Db, RunResult, Stmt } from "./types";

interface TxCtx {
  depth: number;
}

/**
 * Motor SQLite (better-sqlite3 es síncrono): se envuelve en promesas y las transacciones se serializan.
 * Mientras una transacción está abierta, las consultas de otras solicitudes esperan su turno para no mezclarse con ella;
 * las que se hacen dentro de la transacción (mismo contexto asíncrono) pasan directo.
 */
export class SqliteDb implements Db {
  readonly dialect = "sqlite" as const;
  readonly cache: Db["cache"] = {};
  readonly raw: Database.Database;
  private als = new AsyncLocalStorage<TxCtx>();
  private statements = new Map<string, Database.Statement>();
  /** Se resuelve cuando la transacción abierta termina (null si no hay ninguna). */
  private open: Promise<void> | null = null;

  constructor(file: string) {
    this.raw = new Database(file);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("foreign_keys = ON");
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
        return this.stmt(sql).get(...p);
      },
      all: async (...p) => {
        await this.gate();
        return this.stmt(sql).all(...p);
      },
      run: async (...p) => {
        await this.gate();
        const r = this.stmt(sql).run(...p);
        return { changes: r.changes } satisfies RunResult;
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
        // Anidada: punto de guardado (igual que better-sqlite3)
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
          if (this.raw.inTransaction) this.raw.exec("ROLLBACK");
          throw e;
        }
      } finally {
        this.open = null;
        release();
      }
    };
  }

  async backup(file: string) {
    await this.raw.backup(file);
  }

  async close() {
    this.raw.close();
  }
}
