import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { newId, type Db } from "../db";
import { hashSecret, verifySecret } from "../crypto";
import { HttpError } from "../domain";
import { PLANS, generateSigningKeys, signLicense, type LicensePayload } from "../license";

const hashKey = (k: string) => createHash("sha256").update(k).digest("hex");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const LICENSE_DAYS = 30;

export interface HqOptions {
  /** Token de la plataforma (quien opera el SaaS) para crear organizaciones y cambiar planes. */
  adminToken?: string;
}

async function signingKeys(db: Db) {
  const get = async (k: string) => (await db.prepare("SELECT value FROM settings WHERE key=?").get(k) as { value: string } | undefined)?.value;
  let priv = await get("hq_private_key");
  let pub = await get("hq_public_key_own");
  if (!priv || !pub) {
    const k = generateSigningKeys();
    priv = k.privateKey;
    pub = k.publicKey;
    await db.prepare("INSERT INTO settings (key,value) VALUES ('hq_private_key',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(priv);
    await db.prepare("INSERT INTO settings (key,value) VALUES ('hq_public_key_own',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(pub);
  }
  return { priv, pub };
}

/** Nube / HQ (Fase 3): organizaciones aisladas, sucursales, ventas consolidadas, catálogo maestro y licencias por plan. */
export async function hqRoutes(app: FastifyInstance, opts: HqOptions) {
  const { db } = app;
  const keys = await signingKeys(db);

  const isPlatformAdmin = (req: FastifyRequest) => {
    const given = Buffer.from(String(req.headers["x-hq-admin"] ?? ""));
    const want = Buffer.from(opts.adminToken ?? "");
    return want.length > 0 && given.length === want.length && timingSafeEqual(given, want);
  };

  /** Sesión de usuario de una organización (JWT con marca hq). */
  const orgSession = (req: FastifyRequest) => {
    try {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const p = app.jwt.verify(token) as unknown as { hq?: boolean; org?: string; sub?: string; role?: string };
      if (p.hq && p.org) return { org: p.org, user: p.sub!, role: p.role! };
    } catch {
      /* cae al error de abajo */
    }
    throw new HttpError(401, "no_autenticado");
  };
  const owner = (req: FastifyRequest) => {
    const s = orgSession(req);
    if (s.role !== "owner") throw new HttpError(403, "solo_propietario");
    return s;
  };

  /** Sucursal autenticada por su llave. */
  const branchSession = async (req: FastifyRequest) => {
    const key = String(req.headers["x-branch-key"] ?? "");
    const b = key
      ? (await db
                  .prepare("SELECT b.id, b.org_id, b.name, o.plan FROM hq_branches b JOIN hq_orgs o ON o.id=b.org_id WHERE b.key_hash=? AND b.active=1 AND o.active=1")
                  .get(hashKey(key)) as { id: string; org_id: string; name: string; plan: string } | undefined)
      : undefined;
    if (!b) throw new HttpError(401, "llave_invalida");
    await db.prepare("UPDATE hq_branches SET last_seen=? WHERE id=?").run(Date.now(), b.id);
    return b;
  };

  app.get("/api/hq/public-key", async () => ({ public_key: keys.pub }));

  // ---------- Plataforma ----------
  app.post("/api/hq/orgs", async (req, reply) => {
    if (!isPlatformAdmin(req)) throw new HttpError(401, "no_autenticado");
    const b = z
      .object({ name: z.string().min(1), plan: z.enum(Object.keys(PLANS) as [string, ...string[]]).default("gratis"), owner: z.object({ username: z.string().min(3), password: z.string().min(8) }) })
      .parse(req.body);
    const orgId = newId();
    await db.transaction(async () => {
            await db.prepare("INSERT INTO hq_orgs (id,name,plan,created_at) VALUES (?,?,?,?)").run(orgId, b.name, b.plan, Date.now());
            await db.prepare("INSERT INTO hq_users (id,org_id,username,password_hash,role) VALUES (?,?,?,?,'owner')").run(newId(), orgId, b.owner.username, hashSecret(b.owner.password));
          })();
    return reply.code(201).send({ id: orgId });
  });

  app.patch("/api/hq/orgs/:id", async (req) => {
    if (!isPlatformAdmin(req)) throw new HttpError(401, "no_autenticado");
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = z.object({ plan: z.enum(Object.keys(PLANS) as [string, ...string[]]).optional(), active: z.boolean().optional() }).parse(req.body);
    if (b.plan) await db.prepare("UPDATE hq_orgs SET plan=? WHERE id=?").run(b.plan, id);
    if (b.active !== undefined) await db.prepare("UPDATE hq_orgs SET active=? WHERE id=?").run(b.active ? 1 : 0, id);
    return { ok: true };
  });

  // ---------- Organización ----------
  app.post("/api/hq/login", async (req, reply) => {
    const b = z.object({ username: z.string(), password: z.string() }).parse(req.body);
    const u = await db
          .prepare("SELECT u.id, u.org_id, u.role, u.password_hash, o.active FROM hq_users u JOIN hq_orgs o ON o.id=u.org_id WHERE u.username=?")
          .get(b.username) as { id: string; org_id: string; role: string; password_hash: string; active: number } | undefined;
    if (!u || !u.active || !verifySecret(b.password, u.password_hash)) return reply.code(401).send({ error: "credenciales_invalidas" });
    return { token: app.jwt.sign({ hq: true, org: u.org_id, sub: u.id, role: u.role } as never) };
  });

  app.get("/api/hq/me", async (req) => {
    const s = orgSession(req);
    const org = await db.prepare("SELECT id, name, plan FROM hq_orgs WHERE id=?").get(s.org) as { id: string; name: string; plan: string };
    return { ...org, role: s.role, limits: PLANS[org.plan], branches_used: (await db.prepare("SELECT COUNT(*) c FROM hq_branches WHERE org_id=? AND active=1").get(s.org) as { c: number }).c };
  });

  app.post("/api/hq/branches", async (req, reply) => {
    const s = owner(req);
    const { name } = z.object({ name: z.string().min(1) }).parse(req.body);
    const org = await db.prepare("SELECT plan FROM hq_orgs WHERE id=?").get(s.org) as { plan: string };
    const limit = PLANS[org.plan]?.branches ?? null;
    const used = (await db.prepare("SELECT COUNT(*) c FROM hq_branches WHERE org_id=? AND active=1").get(s.org) as { c: number }).c;
    if (limit !== null && used >= limit) throw new HttpError(402, "limite_plan", `Tu plan ${org.plan} permite ${limit} sucursal(es)`);
    const id = newId();
    const key = `bk_${randomBytes(24).toString("hex")}`;
    await db.prepare("INSERT INTO hq_branches (id,org_id,name,key_hash,created_at) VALUES (?,?,?,?,?)").run(id, s.org, name, hashKey(key), Date.now());
    // La llave se muestra una sola vez
    return reply.code(201).send({ id, api_key: key });
  });

  app.get("/api/hq/branches", async (req) => {
    const s = orgSession(req);
    return db.prepare("SELECT id, name, last_seen, active, created_at FROM hq_branches WHERE org_id=? ORDER BY name").all(s.org);
  });

  app.patch("/api/hq/branches/:id", async (req) => {
    const s = owner(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    const r = await db.prepare("UPDATE hq_branches SET active=? WHERE id=? AND org_id=?").run(active ? 1 : 0, id, s.org);
    if (r.changes === 0) throw new HttpError(404, "no_encontrado");
    return { ok: true };
  });

  // ---------- Ventas consolidadas ----------
  app.post("/api/hq/ingest", async (req) => {
    const b = await branchSession(req);
    const body = z
      .object({
        days: z
          .array(
            z.object({
              day,
              tickets: z.number().int().min(0),
              sales_cents: z.number().int().min(0),
              tips_cents: z.number().int().min(0).default(0),
              discounts_cents: z.number().int().min(0).default(0),
              cancelled_items: z.number().int().min(0).default(0),
              products: z.array(z.object({ product: z.string(), units: z.number().int(), sales_cents: z.number().int() })).max(500).default([]),
            }),
          )
          .max(62),
      })
      .parse(req.body);
    await db.transaction(async () => {
            for (const d of body.days) {
              await db.prepare(
                          `INSERT INTO hq_sales (branch_id,day,tickets,sales_cents,tips_cents,discounts_cents,cancelled_items) VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(branch_id,day) DO UPDATE SET tickets=excluded.tickets, sales_cents=excluded.sales_cents, tips_cents=excluded.tips_cents, discounts_cents=excluded.discounts_cents, cancelled_items=excluded.cancelled_items`,
                        ).run(b.id, d.day, d.tickets, d.sales_cents, d.tips_cents, d.discounts_cents, d.cancelled_items);
              await db.prepare("DELETE FROM hq_product_sales WHERE branch_id=? AND day=?").run(b.id, d.day);
              for (const p of d.products) await db.prepare("INSERT INTO hq_product_sales (branch_id,day,product,units,sales_cents) VALUES (?,?,?,?,?)").run(b.id, d.day, p.product, p.units, p.sales_cents);
            }
          })();
    return { ok: true, days: body.days.length };
  });

  const range = z.object({ from: day.optional(), to: day.optional() });

  // Todo se filtra por la organización de la sesión: una organización jamás ve datos de otra
  app.get("/api/hq/reports/summary", async (req) => {
    const s = orgSession(req);
    const q = range.parse(req.query);
    const from = q.from ?? "0000-01-01";
    const to = q.to ?? "9999-12-31";
    const perBranch = await db
          .prepare(
            `SELECT b.id, b.name, COALESCE(SUM(s.tickets),0) tickets, COALESCE(SUM(s.sales_cents),0) sales_cents, COALESCE(SUM(s.tips_cents),0) tips_cents,
                COALESCE(SUM(s.discounts_cents),0) discounts_cents, COALESCE(SUM(s.cancelled_items),0) cancelled_items
         FROM hq_branches b LEFT JOIN hq_sales s ON s.branch_id=b.id AND s.day>=? AND s.day<=?
         WHERE b.org_id=? GROUP BY b.id ORDER BY sales_cents DESC`,
          )
          .all(from, to, s.org) as { tickets: number; sales_cents: number; tips_cents: number }[];
    const total = perBranch.reduce((a, r) => ({ tickets: a.tickets + r.tickets, sales_cents: a.sales_cents + r.sales_cents, tips_cents: a.tips_cents + r.tips_cents }), { tickets: 0, sales_cents: 0, tips_cents: 0 });
    const byDay = await db
          .prepare(
            `SELECT s.day, SUM(s.tickets) tickets, SUM(s.sales_cents) sales_cents FROM hq_sales s JOIN hq_branches b ON b.id=s.branch_id
         WHERE b.org_id=? AND s.day>=? AND s.day<=? GROUP BY s.day ORDER BY s.day`,
          )
          .all(s.org, from, to);
    return { branches: perBranch, total: { ...total, average_ticket_cents: total.tickets ? Math.round(total.sales_cents / total.tickets) : 0 }, by_day: byDay };
  });

  app.get("/api/hq/reports/products", async (req) => {
    const s = orgSession(req);
    const q = range.parse(req.query);
    return db
      .prepare(
        `SELECT p.product, SUM(p.units) units, SUM(p.sales_cents) sales_cents FROM hq_product_sales p JOIN hq_branches b ON b.id=p.branch_id
         WHERE b.org_id=? AND p.day>=? AND p.day<=? GROUP BY p.product ORDER BY sales_cents DESC LIMIT 100`,
      )
      .all(s.org, q.from ?? "0000-01-01", q.to ?? "9999-12-31");
  });

  // ---------- Catálogo maestro ----------
  const catalogRows = async (orgId: string) => {
    const rows = await db.prepare("SELECT sku, name, price_cents, category, station_names, active FROM hq_catalog WHERE org_id=? ORDER BY name").all(orgId) as { station_names: string }[];
    return rows.map((r) => ({ ...r, station_names: JSON.parse(r.station_names) as string[] }));
  };

  app.get("/api/hq/catalog", async (req) => {
    const orgId = req.headers["x-branch-key"] ? (await branchSession(req)).org_id : orgSession(req).org;
    return catalogRows(orgId);
  });

  app.put("/api/hq/catalog", async (req) => {
    const s = owner(req);
    const b = z
      .object({
        products: z
          .array(z.object({ sku: z.string().min(1), name: z.string().min(1), price_cents: z.number().int().min(0), category: z.string().nullable().optional(), station_names: z.array(z.string()).default([]), active: z.boolean().default(true) }))
          .max(2000),
      })
      .parse(req.body);
    await db.transaction(async () => {
            for (const p of b.products) {
              await db.prepare(
                          `INSERT INTO hq_catalog (id,org_id,sku,name,price_cents,category,station_names,active) VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(org_id,sku) DO UPDATE SET name=excluded.name, price_cents=excluded.price_cents, category=excluded.category, station_names=excluded.station_names, active=excluded.active`,
                        ).run(newId(), s.org, p.sku, p.name, p.price_cents, p.category ?? null, JSON.stringify(p.station_names), p.active ? 1 : 0);
            }
          })();
    return { ok: true, products: b.products.length };
  });

  // ---------- Licencia ----------
  app.get("/api/hq/license", async (req) => {
    const b = await branchSession(req);
    const plan = PLANS[b.plan] ?? PLANS.gratis!;
    const now = Date.now();
    const payload: LicensePayload = {
      org: b.org_id, branch: b.id, plan: b.plan,
      limits: { users: plan.users, printers: plan.printers },
      features: plan.features, iat: now, exp: now + LICENSE_DAYS * 86_400_000,
    };
    return { token: signLicense(keys.priv, payload), plan: b.plan };
  });
}
