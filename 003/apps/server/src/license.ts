import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import type { Db } from "./db";

/** Planes SaaS (Fase 3, sec. 64). `null` = sin límite. */
export const FEATURES = ["inventario", "delivery", "qr", "analitica", "facturacion", "integraciones"] as const;
export type Feature = (typeof FEATURES)[number];

export interface PlanDef { branches: number | null; users: number | null; printers: number | null; features: readonly Feature[]; }

export const PLANS: Record<string, PlanDef> = {
  gratis: { branches: 1, users: 3, printers: 1, features: [] },
  basico: { branches: 1, users: 10, printers: 3, features: ["inventario", "delivery"] },
  profesional: { branches: 3, users: 30, printers: 10, features: ["inventario", "delivery", "qr", "analitica", "facturacion", "integraciones"] },
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
}

/** Días tras el vencimiento en que la sucursal sigue operando con el plan contratado (nunca se detiene la venta). */
export const GRACE_DAYS = 7;

const b64 = (b: Buffer) => b.toString("base64url");

export function generateSigningKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

export function signLicense(privatePem: string, payload: LicensePayload): string {
  const body = b64(Buffer.from(JSON.stringify(payload)));
  return `${body}.${b64(sign(null, Buffer.from(body), createPrivateKey(privatePem)))}`;
}

export function verifyLicense(publicPem: string, token: string): LicensePayload | null {
  try {
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;
    if (!verify(null, Buffer.from(body), createPublicKey(publicPem), Buffer.from(sig, "base64url"))) return null;
    return JSON.parse(Buffer.from(body, "base64url").toString()) as LicensePayload;
  } catch {
    return null;
  }
}

const setting = async (db: Db, key: string) => (await db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined)?.value;

export interface ActiveLicense extends LicensePayload { expired: boolean; }

let cache: { token: string; pub: string; value: ActiveLicense | null; at: number } | null = null;

/**
 * Licencia vigente de esta sucursal. Sin licencia instalada devuelve null: instalación propia, sin límites.
 * Con licencia vencida más allá de la gracia se aplican los límites del plan gratis.
 */
export async function getLicense(db: Db, now = Date.now()): Promise<ActiveLicense | null> {
  const token = await setting(db, "license");
  const pub = await setting(db, "hq_public_key");
  if (!token || !pub) return null;
  if (!cache || cache.token !== token || cache.pub !== pub) {
    const payload = verifyLicense(pub, token);
    cache = { token, pub, value: payload ? { ...payload, expired: false } : null, at: now };
  }
  const lic = cache.value;
  if (!lic) return fallbackFree();
  const expired = now > lic.exp;
  if (expired && now > lic.exp + GRACE_DAYS * 86_400_000) return fallbackFree();
  return { ...lic, expired };
}

/** Licencia presente pero inválida o vencida: plan gratis (sigue pudiendo vender, sin funciones extra). */
function fallbackFree(): ActiveLicense {
  const p = PLANS.gratis!;
  return { org: "", branch: "", plan: "gratis", limits: { users: p.users, printers: p.printers }, features: p.features, iat: 0, exp: 0, expired: true };
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
    users: (await db.prepare("SELECT COUNT(*) c FROM users WHERE active=1").get() as { c: number }).c,
    printers: (await db.prepare("SELECT COUNT(*) c FROM printers WHERE active=1").get() as { c: number }).c,
  };
}
