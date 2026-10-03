import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface LogStreamOptions {
  dir: string;
  /** Nombre base del archivo (`nodo` → `nodo.log`, `nodo.log.1`…). */
  name?: string;
  /** Tamaño a partir del cual se rota. */
  maxBytes?: number;
  /** Cuántos archivos se conservan (el activo más los rotados). */
  keep?: number;
  /** También escribe en la salida estándar (desarrollo y consola del servicio). */
  echo?: boolean;
}

/**
 * Destino de registros con rotación por tamaño. Las escrituras son síncronas a propósito: se registra poco (arranque,
 * errores, respaldos) y así nada se pierde si el proceso muere justo después.
 */
export class RotatingLog {
  private file: string;
  private size = 0;
  constructor(private opts: LogStreamOptions) {
    mkdirSync(opts.dir, { recursive: true });
    this.file = join(opts.dir, `${opts.name ?? "nodo"}.log`);
    this.size = existsSync(this.file) ? statSync(this.file).size : 0;
  }

  /** Interfaz mínima que Fastify (pino) espera de un `stream`. */
  write(chunk: string | Buffer): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const max = this.opts.maxBytes ?? 5 * 1024 * 1024;
    if (this.size + text.length > max && this.size > 0) this.rotate();
    appendFileSync(this.file, text);
    this.size += text.length;
    if (this.opts.echo) process.stdout.write(text);
  }

  private rotate() {
    const keep = Math.max(1, this.opts.keep ?? 5);
    rmSync(`${this.file}.${keep - 1}`, { force: true });
    for (let i = keep - 2; i >= 1; i--) {
      if (existsSync(`${this.file}.${i}`)) renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
    }
    if (keep > 1) renameSync(this.file, `${this.file}.1`);
    else rmSync(this.file, { force: true });
    this.size = 0;
  }
}

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50 } as const;
export type LogLevel = keyof typeof LEVELS;

/** Registrador del ciclo de vida (arranque, apagado, respaldos). Escribe líneas JSON con el mismo formato que pino. */
export class Logger {
  constructor(
    private stream: { write(s: string): void },
    private level: LogLevel = "info",
  ) {}

  private emit(level: LogLevel, msg: string, extra?: Record<string, unknown>) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    this.stream.write(
      `${JSON.stringify({ level: LEVELS[level], time: Date.now(), msg, ...extra })}\n`,
    );
  }
  debug(msg: string, extra?: Record<string, unknown>) {
    this.emit("debug", msg, extra);
  }
  info(msg: string, extra?: Record<string, unknown>) {
    this.emit("info", msg, extra);
  }
  warn(msg: string, extra?: Record<string, unknown>) {
    this.emit("warn", msg, extra);
  }
  error(msg: string, extra?: Record<string, unknown>) {
    this.emit("error", msg, extra);
  }
}

/** Convierte un error en algo que se pueda escribir en el registro. */
export const errorFields = (e: unknown) =>
  e instanceof Error
    ? { err: { name: e.name, message: e.message, stack: e.stack } }
    : { err: { message: String(e) } };

/**
 * Opciones del registrador de Fastify. No se registra cada petición; la URL se escribe sin parámetros porque el
 * WebSocket lleva el JWT en `?token=` y no debe quedar en un archivo.
 */
export function fastifyLoggerOptions(stream: { write(s: string): void }, level: LogLevel) {
  return {
    level,
    stream,
    serializers: {
      req: (req: { method?: string; url?: string }) => ({
        method: req.method,
        url: (req.url ?? "").split("?")[0],
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    },
  };
}
