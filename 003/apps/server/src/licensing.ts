import { machineFingerprint } from "./fingerprint";
import type { LicensingContext } from "./license";

/**
 * El empaquetado sustituye estas expresiones (esbuild `define`) por valores fijos del paquete de producción:
 *  - `NODO_LICENSE_MODE = "enforced"` y `NODO_LICENSE_PUBLIC_KEYS = '["-----BEGIN PUBLIC KEY-----…"]'`.
 * En desarrollo son `undefined` y el modo sale del entorno.
 */
const BUILT_MODE: string | undefined = process.env.NODO_LICENSE_MODE;
const BUILT_KEYS: string | undefined = process.env.NODO_LICENSE_PUBLIC_KEYS;
const BUILT_HQ_URL: string | undefined = process.env.NODO_HQ_URL;

type Env = Record<string, string | undefined>;

const parseKeys = (raw: string | undefined): string[] => {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return raw.includes("BEGIN PUBLIC KEY") ? [raw] : [];
  }
};

/**
 * Contexto de licencia del arranque. En un paquete de producción (`enforced` horneado) **no se mira el entorno**: ni el
 * modo ni las claves se pueden cambiar con una variable (invariante I3.3). Un paquete `enforced` sin claves no arranca:
 * es un error de construcción y debe notarse, no degradarse en silencio.
 */
export async function loadLicensing(env: Env = process.env): Promise<LicensingContext> {
  if (BUILT_MODE === "enforced") {
    const publicKeys = parseKeys(BUILT_KEYS);
    if (publicKeys.length === 0)
      throw new Error("Paquete mal construido: modo de licencia «enforced» sin claves públicas");
    return { mode: "enforced", publicKeys, fingerprint: await machineFingerprint() };
  }
  if (env.NODO_LICENSE === "enforced") {
    // Para probar el modo de producción en desarrollo
    return {
      mode: "enforced",
      publicKeys: parseKeys(env.NODO_LICENSE_PUBLIC_KEYS),
      fingerprint: await machineFingerprint(),
    };
  }
  return { mode: "open", publicKeys: [], fingerprint: null };
}

/** Dirección del HQ de Nodo: la del paquete, o la que se indique por entorno. */
export const defaultHqUrl = (env: Env = process.env) => env.NODO_HQ_URL ?? BUILT_HQ_URL ?? null;
