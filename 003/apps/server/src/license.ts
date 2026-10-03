import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import type { Db } from "./db";

/** Planes SaaS (Fase 3, sec. 64). `null` = sin límite. */
export const FEATURES = [
  "inventario",
  "delivery",
  "qr",
  "analitica",
  "facturacion",
  "integraciones",
] as const;
export type Feature = (typeof FEATURES)[number];

export interface PlanDef {
  branches: number | null;
  users: number | null;
  printers: number | null;
  features: readonly Feature[];
}

export const PLANS: Record<string, PlanDef> = {
  gratis: { branches: 1, users: 3, printers: 1, features: [] },
  basico: { branches: 1, users: 10, printers: 3, features: ["inventario", "delivery"] },
  profesional: {
    branches: 3,
    users: 30,
    printers: 10,
    features: ["inventario", "delivery", "qr", "analitica", "facturacion", "integraciones"],
  },
  empresarial: { branches: null, users: null, printers: null, features: FEATURES },
};

export interface LicensePayload {
  org: string;
  branch: string;
  plan: string;
  limits: { users: number | null; printers: number | null };
  features: readonly Feature[];
  iat: number;
  exp: number;
  /** Huella del equipo al que está atada (ver `fingerprint.ts`); sin ella solo vale en modo `open`. */
  fp?: string | null;
  /** Identificador de la clave que firmó (para poder rotar claves). */
  kid?: string;
}

/**
 * Cómo se aplica la licencia:
 *  - `open`: desarrollo, pruebas y demos. Sin licencia no hay límites (comportamiento original).
 *  - `enforced`: paquete de producción. Solo vale una licencia firmada con una clave incrustada en el programa y atada a
 *    este equipo; sin ella, plan `gratis`. **Nunca detiene la venta** (I3).
 */
export interface LicensingContext {
  mode: "open" | "enforced";
  /** Claves públicas aceptadas (PEM). En `enforced` son las incrustadas en el programa. */
  publicKeys: string[];
  /** Huella de este equipo (`null` si no se pudo leer). */
  fingerprint: string | null;
}
export const OPEN_LICENSING: LicensingContext = { mode: "open", publicKeys: [], fingerprint: null };

/** Días tras el vencimiento en que la sucursal sigue operando con el plan contratado (nunca se detiene la venta). */
export const GRACE_DAYS = 7;

const b64 = (b: Buffer) => b.toString("base64url");

export function generateSigningKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function signLicense(privatePem: string, payload: LicensePayload): string {
  const body = b64(Buffer.from(JSON.stringify(payload)));
  return `${body}.${b64(sign(null, Buffer.from(body), createPrivateKey(privatePem)))}`;
}

export function verifyLicense(publicPem: string, token: string): LicensePayload | null {
  try {
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;
    if (!verify(null, Buffer.from(body), createPublicKey(publicPem), Buffer.from(sig, "base64url")))
      return null;
    return JSON.parse(Buffer.from(body, "base64url").toString()) as LicensePayload;
  } catch {
    return null;
  }
}

/** Verifica contra varias claves (rotación): vale la primera que firmó. */
export function verifyLicenseAny(publicPems: string[], token: string): LicensePayload | null {
  for (const pem of publicPems) {
    const p = verifyLicense(pem, token);
    if (p) return p;
  }
  return null;
}

const setting = async (db: Db, key: string) =>
  (
    (await db.prepare("SELECT value FROM settings WHERE key=?").get(key)) as
      | { value: string }
      | undefined
  )?.value;

/** Por qué una sucursal está en el plan restringido. */
export type RestrictedReason =
  | "sin_licencia"
  | "firma_invalida"
  | "sin_huella"
  | "otro_equipo"
  | "vencida";

export interface ActiveLicense extends LicensePayload {
  expired: boolean;
  /** `true` si se aplican los límites del plan gratis por falta de una licencia válida. */
  restricted?: boolean;
  reason?: RestrictedReason;
}

let cache: { key: string; value: LicensePayload | null } | null = null;

/**
 * Licencia vigente de esta sucursal.
 *  - Modo `open` (por defecto): sin licencia instalada devuelve null (instalación propia, sin límites).
 *  - Modo `enforced`: sin licencia válida para este equipo devuelve el plan gratis con el motivo.
 * Con licencia vencida más allá de la gracia se aplican los límites del plan gratis. El reloj no se puede retroceder para
 * alargar una licencia: el vencimiento se evalúa con la hora más alta vista (`license_clock_hwm`).
 */
export async function getLicense(
  db: Db,
  now = Date.now(),
  ctx: LicensingContext = OPEN_LICENSING,
): Promise<ActiveLicense | null> {
  const enforced = ctx.mode === "enforced";
  const token = await setting(db, "license");
  const keys = enforced
    ? ctx.publicKeys
    : [await setting(db, "hq_public_key")].filter((k): k is string => !!k);
  if (!token || keys.length === 0) return enforced ? restricted("sin_licencia") : null;

  const cacheKey = `${token}|${keys.join("|")}`;
  if (!cache || cache.key !== cacheKey)
    cache = { key: cacheKey, value: verifyLicenseAny(keys, token) };
  const lic = cache.value;
  if (!lic) return restricted("firma_invalida");
  if (enforced) {
    if (!lic.fp) return restricted("sin_huella");
    if (lic.fp !== ctx.fingerprint) return restricted("otro_equipo");
  }
  const seen = Number(await setting(db, "license_clock_hwm")) || 0;
  const t = Math.max(now, seen);
  const expired = t > lic.exp;
  if (expired && t > lic.exp + GRACE_DAYS * 86_400_000) return restricted("vencida");
  return { ...lic, expired };
}

/** Anota la hora actual como la más alta vista: así retrasar el reloj del equipo no alarga una licencia. */
export async function noteClock(db: Db, now = Date.now()) {
  const seen = Number(await setting(db, "license_clock_hwm")) || 0;
  if (now <= seen) return;
  await db
    .prepare(
      "INSERT INTO settings (key,value) VALUES ('license_clock_hwm',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(String(now));
}

/** Plan gratis (sigue pudiendo vender, sin funciones extra) por falta de una licencia válida. */
function restricted(reason: RestrictedReason): ActiveLicense {
  const p = PLANS.gratis!;
  return {
    org: "",
    branch: "",
    plan: "gratis",
    limits: { users: p.users, printers: p.printers },
    features: p.features,
    iat: 0,
    exp: 0,
    expired: true,
    restricted: true,
    reason,
  };
}

/** Rutas que requieren una función del plan (solo se aplican si hay licencia instalada). */
export const FEATURE_ROUTES: [RegExp, Feature][] = [
  [/^\/api\/(inventory|recipes|suppliers|purchase-orders|shopping-lists)(\/|$)/, "inventario"],
  [/^\/api\/(delivery|orders\/external)(\/|$)/, "delivery"],
  [/^\/api\/public(\/|$)/, "qr"],
  [/^\/api\/tables\/[^/]+\/qr$/, "qr"],
  [/^\/api\/analytics(\/|$)/, "analitica"],
  [/^\/api\/invoices(\/|$)/, "facturacion"],
  [/^\/api\/accounts\/[^/]+\/invoice$/, "facturacion"],
  [/^\/api\/(integrations|webhooks)(\/|$)/, "integraciones"],
];

/** Cuenta para aplicar límites del plan. */
export async function usage(db: Db) {
  return {
    users: (
      (await db.prepare("SELECT COUNT(*) c FROM users WHERE active=1").get()) as { c: number }
    ).c,
    printers: (
      (await db.prepare("SELECT COUNT(*) c FROM printers WHERE active=1").get()) as { c: number }
    ).c,
  };
}
