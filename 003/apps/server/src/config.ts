import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Configuración del servidor, resuelta una sola vez desde el entorno. */
export interface Config {
  /** Carpeta que contiene base, fotos, respaldos y registros. Nunca va junto al programa (se conserva al actualizar). */
  dataDir: string;
  dbFile: string;
  backupDir: string;
  photosDir: string;
  logDir: string;
  webDir: string;
  port: number;
  host: string;
  /** `hq` = servidor de la nube; cualquier otro valor = servidor de un local. */
  role: "local" | "hq";
  version: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

type Env = Record<string, string | undefined>;

/** El empaquetado (esbuild `define`) sustituye esta expresión por la versión del paquete; en desarrollo es `undefined`. */
const BUILT_VERSION: string | undefined = process.env.NODO_VERSION;

/**
 * Versión del programa. El empaquetado la fija en `NODO_VERSION`; en desarrollo sale del `package.json` del servidor.
 */
export function appVersion(env: Env = process.env): string {
  if (env.NODO_VERSION ?? BUILT_VERSION) return (env.NODO_VERSION ?? BUILT_VERSION) as string;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, "../package.json"), "utf8")).version ?? "dev";
  } catch {
    return "dev";
  }
}

/**
 * Carpeta de datos por defecto de un equipo instalado. El servicio la fija con `NODO_DATA_DIR`; esto es lo que
 * documenta el instalador y lo que usa quien arranca el paquete a mano.
 */
export function defaultDataDir(platform: NodeJS.Platform, env: Env): string {
  if (platform === "win32") return join(env.ProgramData ?? "C:\\ProgramData", "Nodo");
  if (platform === "darwin") return join(env.HOME ?? "~", "Library", "Application Support", "Nodo");
  return "/var/lib/nodo";
}

/** Carpeta de la app web: `web/` junto al programa empaquetado o, en desarrollo, la compilación de apps/web. */
function findWebDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "web"), resolve(here, "../../web/dist")];
  return candidates.find((c) => existsSync(join(c, "index.html"))) ?? candidates[1]!;
}

export function loadConfig(env: Env = process.env, cwd = process.cwd()): Config {
  // Compatibilidad: sin carpeta de datos ni variables sueltas se mantiene `data/` junto a donde se arranca (desarrollo)
  const dataDir = resolve(cwd, env.NODO_DATA_DIR ?? (env.DB_FILE ? dirname(env.DB_FILE) : "data"));
  const dbFile = env.DB_FILE ?? join(dataDir, env.NODO_DATA_DIR ? "nodo.sqlite" : "003.sqlite");
  const level = env.NODO_LOG_LEVEL;
  return {
    dataDir,
    dbFile,
    backupDir: env.BACKUP_DIR ?? join(dataDir, "backups"),
    photosDir: env.PHOTOS_DIR ?? join(dataDir, "photos"),
    logDir: env.LOG_DIR ?? join(dataDir, "logs"),
    webDir: env.WEB_DIR ?? findWebDir(),
    port: Number(env.PORT ?? 3003),
    host: env.HOST ?? "0.0.0.0",
    role: env.ROLE === "hq" ? "hq" : "local",
    version: appVersion(env),
    logLevel: level === "debug" || level === "info" || level === "error" ? level : "warn",
  };
}
