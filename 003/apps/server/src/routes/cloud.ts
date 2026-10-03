import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, newId, type Db } from "../db";
import { HttpError } from "../domain";
import { hostname } from "node:os";
import { machineFingerprint, shortFingerprint } from "../fingerprint";
import {
  type LicensingContext,
  OPEN_LICENSING,
  getLicense,
  noteClock,
  usage,
  verifyLicenseAny,
} from "../license";

/** Cliente HTTP mínimo (inyectable para pruebas y para correr sin Internet). */
export type HttpLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const setting = async (db: Db, key: string) =>
  (
    (await db.prepare("SELECT value FROM settings WHERE key=?").get(key)) as
      | { value: string }
      | undefined
  )?.value;
const put = (db: Db, key: string, value: string) =>
  db
    .prepare(
      "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(key, value);

const localDay = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Resumen diario de ventas de los últimos `days` días (se reenvía completo: el HQ lo reemplaza, así un reintento nunca duplica). */
export async function buildSalesDays(db: Db, days = 7, now = Date.now()) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const start = new Date(now - i * 86_400_000);
    start.setHours(0, 0, 0, 0);
    const a = start.getTime();
    const b = a + 86_400_000;
    const s = (await db
      .prepare(
        "SELECT COUNT(DISTINCT account_id) tickets, COALESCE(SUM(total_cents),0) sales, COALESCE(SUM(tip_cents),0) tips FROM payments WHERE created_at>=? AND created_at<?",
      )
      .get(a, b)) as { tickets: number; sales: number; tips: number };
    if (s.tickets === 0) continue;
    const discounts = (
      (await db
        .prepare(
          "SELECT COALESCE(SUM(amount_cents),0) t FROM account_discounts WHERE created_at>=? AND created_at<?",
        )
        .get(a, b)) as { t: number }
    ).t;
    const cancelled = (
      (await db
        .prepare(
          "SELECT COUNT(*) c FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.status='cancelado' AND o.created_at>=? AND o.created_at<?",
        )
        .get(a, b)) as { c: number }
    ).c;
    const products = await db
      .prepare(
        `SELECT i.name product, SUM(i.quantity) units, SUM(i.quantity*i.unit_price_cents) sales_cents FROM order_items i
         WHERE i.status='activo' AND i.account_id IN (SELECT account_id FROM payments WHERE created_at>=? AND created_at<?) GROUP BY i.product_id, i.name`,
      )
      .all(a, b);
    out.push({
      day: localDay(a),
      tickets: s.tickets,
      sales_cents: s.sales,
      tips_cents: s.tips,
      discounts_cents: discounts,
      cancelled_items: cancelled,
      products,
    });
  }
  return out;
}

interface HqProduct {
  sku: string;
  name: string;
  price_cents: number;
  category: string | null;
  station_names: string[];
  active: boolean;
}

/** Aplica el catálogo maestro: crea o actualiza por SKU y resuelve las estaciones por nombre. */
export async function applyCatalog(db: Db, products: HqProduct[]) {
  const res = { created: 0, updated: 0, skipped: [] as { sku: string; reason: string }[] };
  await db.transaction(async () => {
    for (const p of products) {
      const stationIds: string[] = [];
      for (const n of p.station_names) {
        const s = (await db.prepare("SELECT id FROM stations WHERE name=?").get(n)) as
          | { id: string }
          | undefined;
        if (s) stationIds.push(s.id);
      }
      let categoryId: string | null = null;
      if (p.category) {
        const c = (await db.prepare("SELECT id FROM categories WHERE name=?").get(p.category)) as
          | { id: string }
          | undefined;
        categoryId = c?.id ?? null;
        if (!categoryId) {
          categoryId = newId();
          await db
            .prepare("INSERT INTO categories (id,name) VALUES (?,?)")
            .run(categoryId, p.category);
        }
      }
      const existing = (await db.prepare("SELECT id FROM products WHERE sku=?").get(p.sku)) as
        | { id: string }
        | undefined;
      if (existing) {
        await db
          .prepare("UPDATE products SET name=?, price_cents=?, category_id=?, active=? WHERE id=?")
          .run(p.name, p.price_cents, categoryId, p.active ? 1 : 0, existing.id);
        // Las rutas solo se reemplazan si todas las estaciones existen aquí; si no, se conservan las locales
        if (stationIds.length && stationIds.length === p.station_names.length) {
          await db.prepare("DELETE FROM product_routes WHERE product_id=?").run(existing.id);
          for (const sid of stationIds)
            await db
              .prepare("INSERT INTO product_routes (product_id,station_id) VALUES (?,?)")
              .run(existing.id, sid);
        }
        res.updated++;
      } else if (stationIds.length === 0) {
        // Un producto sin ruta de producción no puede venderse (RN-003)
        res.skipped.push({
          sku: p.sku,
          reason: `Sin estación local: ${p.station_names.join(", ") || "(ninguna)"}`,
        });
      } else {
        const id = newId();
        await db
          .prepare(
            "INSERT INTO products (id,category_id,name,sku,price_cents,active) VALUES (?,?,?,?,?,?)",
          )
          .run(id, categoryId, p.name, p.sku, p.price_cents, p.active ? 1 : 0);
        for (const sid of stationIds)
          await db
            .prepare("INSERT INTO product_routes (product_id,station_id) VALUES (?,?)")
            .run(id, sid);
        res.created++;
      }
    }
  })();
  return res;
}

export interface SyncReport {
  sales: { ok: boolean; days?: number; error?: string };
  license: { ok: boolean; plan?: string; error?: string };
  catalog: {
    ok: boolean;
    created?: number;
    updated?: number;
    skipped?: { sku: string; reason: string }[];
    error?: string;
  };
}

/** Sincroniza con la nube. Cada paso es independiente: si falla uno (sin Internet), los demás siguen y la sucursal sigue operando. */
export async function syncWithHq(
  db: Db,
  http: HttpLike,
  licensing: LicensingContext = OPEN_LICENSING,
): Promise<SyncReport> {
  const url = await setting(db, "hq_url");
  const key = await setting(db, "hq_key");
  if (!url || !key)
    throw new HttpError(409, "sin_vincular", "Esta sucursal no está vinculada a la nube");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-branch-key": key,
  };
  // El HQ solo entrega licencia al equipo con el que se activó la sucursal
  if (licensing.fingerprint) headers["x-device-fp"] = licensing.fingerprint;
  const call = async (path: string, body?: unknown) => {
    const r = await http(`${url}${path}`, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const report: SyncReport = {
    sales: { ok: false },
    license: { ok: false },
    catalog: { ok: false },
  };

  try {
    const days = await buildSalesDays(db);
    await call("/api/hq/ingest", { days });
    report.sales = { ok: true, days: days.length };
  } catch (e) {
    report.sales = { ok: false, error: msg(e) };
  }

  try {
    const lic = (await call("/api/hq/license")) as { token: string; plan: string };
    // En producción solo valen las claves incrustadas en el programa; la que guardó el HQ al vincular es de desarrollo
    const pub = await setting(db, "hq_public_key");
    const keys = licensing.mode === "enforced" ? licensing.publicKeys : pub ? [pub] : [];
    if (!verifyLicenseAny(keys, lic.token)) throw new Error("La firma de la licencia no es válida");
    await put(db, "license", lic.token);
    await noteClock(db);
    report.license = { ok: true, plan: lic.plan };
  } catch (e) {
    report.license = { ok: false, error: msg(e) };
  }

  try {
    const products = (await call("/api/hq/catalog")) as HqProduct[];
    const r = await applyCatalog(
      db,
      products.map((p) => ({ ...p, active: !!p.active })),
    );
    report.catalog = { ok: true, ...r };
  } catch (e) {
    report.catalog = { ok: false, error: msg(e) };
  }

  await put(db, "hq_last_sync", String(Date.now()));
  return report;
}

/** Vinculación y estado de la sucursal con la nube (Fase 3, sec. 62-64). */
export async function cloudRoutes(app: FastifyInstance, opts: { http: HttpLike }) {
  const { db } = app;

  app.post("/api/cloud/link", { preHandler: app.authorize("user.manage") }, async (req) => {
    const b = z
      .object({ url: z.string().url(), key: z.string().min(10), publicKey: z.string().optional() })
      .parse(req.body);
    const base = b.url.replace(/\/$/, "");
    let pub = b.publicKey;
    if (!pub) {
      // Confianza en el primer uso: se guarda la clave pública del HQ; las licencias posteriores deben venir firmadas con ella
      const r = await opts.http(`${base}/api/hq/public-key`).catch(() => null);
      if (!r?.ok) throw new HttpError(502, "hq_inalcanzable", "No se pudo contactar al HQ");
      pub = ((await r.json()) as { public_key: string }).public_key;
    }
    await put(db, "hq_url", base);
    await put(db, "hq_key", b.key);
    await put(db, "hq_public_key", pub);
    await audit(db, req.user.sub, "vincular_nube", "sistema", undefined, { url: base });
    return { ok: true };
  });

  app.post("/api/cloud/sync", { preHandler: app.authorize("user.manage") }, async (req) => {
    const report = await syncWithHq(db, opts.http, app.licensing);
    await audit(db, req.user.sub, "sincronizar_nube", "sistema", undefined, {
      sales: report.sales.ok,
      license: report.license.ok,
      catalog: report.catalog.ok,
    });
    return report;
  });

  app.post("/api/cloud/unlink", { preHandler: app.authorize("user.manage") }, async (req) => {
    for (const k of ["hq_url", "hq_key", "hq_public_key", "license", "hq_last_sync"])
      await db.prepare("DELETE FROM settings WHERE key=?").run(k);
    await audit(db, req.user.sub, "desvincular_nube", "sistema");
    return { ok: true };
  });

  /**
   * Activación con un código de un solo uso (plan 03). Necesita Internet esta vez: el HQ registra la huella de este
   * equipo, entrega una llave nueva y la licencia firmada, y desde ahí el local opera sin red.
   */
  app.post("/api/license/activate", { preHandler: app.authorize("user.manage") }, async (req) => {
    const b = z
      .object({ code: z.string().min(8).max(40), hqUrl: z.string().url().optional() })
      .parse(req.body);
    const base = (b.hqUrl ?? app.hqUrl ?? "").replace(/\/$/, "");
    if (!base)
      throw new HttpError(409, "sin_hq", "Falta la dirección del servidor de Nodo (hqUrl)");
    const fingerprint = app.licensing.fingerprint ?? (await machineFingerprint());
    if (!fingerprint)
      throw new HttpError(409, "sin_huella", "No se pudo identificar este equipo para activarlo");
    const r = await opts
      .http(`${base}/api/hq/activate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: b.code, fingerprint, device: hostname().slice(0, 80) }),
      })
      .catch(() => null);
    if (!r)
      throw new HttpError(
        502,
        "hq_inalcanzable",
        "No se pudo contactar al servidor de Nodo: la activación necesita Internet",
      );
    const body = (await r.json().catch(() => ({}))) as {
      api_key?: string;
      token?: string;
      plan?: string;
      org?: string;
      branch?: string;
      error?: string;
      message?: string;
    };
    if (!r.ok || !body.api_key || !body.token)
      throw new HttpError(
        r.status === 404 ? 404 : r.status === 429 ? 429 : 502,
        body.error ?? "activacion_fallida",
        body.message ?? "No se pudo activar",
      );
    let pub: string | undefined;
    if (app.licensing.mode === "enforced") {
      if (!verifyLicenseAny(app.licensing.publicKeys, body.token))
        throw new HttpError(
          502,
          "licencia_invalida",
          "El servidor devolvió una licencia que no es de Nodo",
        );
    } else {
      // Modo de desarrollo: confianza en el primer uso de la clave del HQ, como al vincular
      const k = await opts.http(`${base}/api/hq/public-key`).catch(() => null);
      pub = k?.ok ? ((await k.json()) as { public_key: string }).public_key : undefined;
      if (!pub || !verifyLicenseAny([pub], body.token))
        throw new HttpError(502, "licencia_invalida", "La licencia recibida no tiene firma válida");
    }
    await put(db, "hq_url", base);
    await put(db, "hq_key", body.api_key);
    if (pub) await put(db, "hq_public_key", pub);
    await put(db, "license", body.token);
    await noteClock(db);
    await audit(db, req.user.sub, "activar_licencia", "sistema", undefined, {
      url: base,
      plan: body.plan,
    });
    return { ok: true, plan: body.plan, org: body.org, branch: body.branch };
  });

  app.get("/api/cloud/status", { preHandler: app.authorize() }, async () => {
    const lic = await getLicense(db, Date.now(), app.licensing);
    const u = await usage(db);
    const fp = app.licensing.fingerprint ?? (await machineFingerprint());
    return {
      mode: app.licensing.mode,
      fingerprint: fp ? shortFingerprint(fp) : null,
      linked: !!(await setting(db, "hq_url")),
      url: (await setting(db, "hq_url")) ?? null,
      last_sync: (await setting(db, "hq_last_sync"))
        ? Number(await setting(db, "hq_last_sync"))
        : null,
      license: lic
        ? {
            plan: lic.plan,
            expires_at: lic.exp,
            expired: lic.expired,
            restricted: lic.restricted ?? false,
            reason: lic.reason ?? null,
            features: lic.features,
            limits: lic.limits,
          }
        : null,
      usage: u,
    };
  });
}
