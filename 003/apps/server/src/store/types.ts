/**
 * Capa de datos de Nodo: una interfaz ASÍNCRONA con dos motores.
 *  - sqlite: modo local (un archivo, sin internet).
 *  - pg: modo nube (PostgreSQL, un esquema por restaurante).
 * El código de la aplicación usa solo `prepare().get/all/run`, `exec` y `transaction`; no sabe qué motor hay debajo.
 */
export interface RunResult {
  changes: number;
}

export interface Stmt {
  get(...params: any[]): Promise<any>;
  all(...params: any[]): Promise<any[]>;
  run(...params: any[]): Promise<RunResult>;
}

export interface Db {
  readonly dialect: "sqlite" | "pg";
  prepare(sql: string): Stmt;
  /** Ejecuta uno o varios enunciados sin parámetros (migraciones). */
  exec(sql: string): Promise<void>;
  /** Agrupa operaciones: todo o nada. Las consultas hechas dentro (incluso en funciones llamadas) usan la misma transacción. */
  transaction<A extends any[], R>(fn: (...args: A) => Promise<R> | R): (...args: A) => Promise<R>;
  /** Copia consistente de la base a un archivo (solo motor local; en la nube lo hace el proveedor de la base). */
  backup(file: string): Promise<void>;
  close(): Promise<void>;
  /** Valores precargados que el código necesita de forma síncrona (p. ej. el secreto JWT). */
  cache: { jwtSecret?: string };
}
