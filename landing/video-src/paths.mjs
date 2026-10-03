/** Rutas del entorno de cada equipo: se pueden definir por variable de entorno y, si no, se buscan en sitios habituales. */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(fileURLToPath(import.meta.url));

const CHROMES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

/** `CHROME_PATH` o el primer Chrome/Edge que exista. */
export function chromePath() {
  const found = process.env.CHROME_PATH ?? CHROMES.find((p) => existsSync(p));
  if (!found) throw new Error("No se encontró Chrome/Edge: define CHROME_PATH");
  return found;
}

/** Compilación de la app (`pnpm --filter @003/web build`); `NODO_APP_DIST` para otra ubicación. */
export const APP_DIST = process.env.NODO_APP_DIST ?? resolve(ROOT, "../../003/apps/web/dist/assets");
/** Fotos de platillos de la demo; `NODO_LANDING_PHOTOS` para otra ubicación. */
export const PHOTOS = process.env.NODO_LANDING_PHOTOS ?? resolve(ROOT, "../../003/apps/server/data/landing-photos");
