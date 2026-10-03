import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { newId, type Db } from "../db";
import { hashSecret, verifySecret } from "../crypto";
import { HttpError } from "../domain";
import { shortFingerprint } from "../fingerprint";
import { PLANS, generateSigningKeys, signLicense, type LicensePayload } from "../license";

const hashKey = (k: string) => createHash("sha256").update(k).digest("hex");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const LICENSE_DAYS = 30;

export interface HqOptions {
  /** Token de la plataforma (quien opera el SaaS) para crear organizaciones y cambiar planes. */
  adminToken?: string;
  /**
   * Clave privada (PEM) con la que se firman las licencias. En producción viene de un secreto del entorno
   * (`HQ_SIGNING_KEY`); sin ella se genera una en la base, solo para desarrollo.
   */
  signingKey?: string;
  /** Identificador de la clave de firma (para rotarla). */
  keyId?: string;
  /** Carpeta (volumen) donde se guardan los respaldos cifrados de las sucursales. Sin ella, el respaldo en nube no está disponible. */
  backupStoreDir?: string;
  /** Tamaño máximo de un respaldo (por defecto 512 MB). */
  backupMaxBytes?: number;
  /** Espacio máximo de respaldos por sucursal (por defecto 5 GB). */
  branchQuotaBytes?: number;
}

// Sin caracteres que se confundan al dictarlos (0/O, 1/I): 32 símbolos = 5 bits cada uno, 12 símbolos = 60 bits
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_DAYS = 7;
const newCode = () => {
  const raw = Array.from({ length: 12 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(
    "",
  );
  return `NODO-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
};
/** Mayúsculas y sin separadores: se tolera que lo tecleen con o sin guiones. */
const normalizeCode = (c: string) =>
  c
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^NODO/, "");
const hashCode = (c: string) =>
  createHash("sha256")
    .update(`nodo-activacion:${normalizeCode(c)}`)
    .digest("hex");

async function signingKeys(db: Db, opts: HqOptions) {
  if (opts.signingKey) {
    const priv = opts.signingKey.replace(/\\n/g, "\n");
    const pub = createPublicKey(createPrivateKey(priv))
      .export({ type: "spki", format: "pem" })
      .toString();
    return { priv, pub };
  }
  const get = async (k: string) =>
    (
      (await db.prepare("SELECT value FROM settings WHERE key=?").get(k)) as
        | { value: string }
        | undefined
    )?.value;
  let priv = await get("hq_private_key");
  let pub = await get("hq_public_key_own");
  if (!priv || !pub) {
    const k = generateSigningKeys();
    priv = k.privateKey;
    pub = k.publicKey;
    await db
      .prepare(
        "INSERT INTO settings (key,value) VALUES ('hq_private_key',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(priv);
    await db
      .prepare(
        "INSERT INTO settings (key,value) VALUES ('hq_public_key_own',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(pub);
  }
  return { priv, pub };
}

/** Nube / HQ (Fase 3): organizaciones aisladas, sucursales, ventas consolidadas, catálogo maestro y licencias por plan. */
export async function hqRoutes(app: FastifyInstance, opts: HqOptions) {
  const { db } = app;
  const keys = await signingKeys(db, opts);
  // Intentos de activación por IP (ventana de 10 min): con 60 bits de código no es una amenaza real, pero no cuesta limitar
  const attempts = new Map<string, number[]>();
  const tooMany = (ip: string) => {
    const now = Date.now();
    const recent = (attempts.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
    recent.push(now);
    attempts.set(ip, recent);
    return recent.length > 10;
  };

  const isPlatformAdmin = (req: FastifyRequest) => {
    const given = Buffer.from(String(req.headers["x-hq-admin"] ?? ""));
    const want = Buffer.from(opts.adminToken ?? "");
    return want.length > 0 && given.length === want.length && timingSafeEqual(given, want);
  };

  /** Sesión de usuario de una organización (JWT con marca hq). */
  const orgSession = (req: FastifyRequest) => {
    try {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const p = app.jwt.verify(token) as unknown as {
        hq?: boolean;
        org?: string;
        sub?: string;
        role?: string;
      };
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
      ? ((await db
          .prepare(
            "SELECT b.id, b.org_id, b.name, o.plan, o.paid_until FROM hq_branches b JOIN hq_orgs o ON o.id=b.org_id WHERE b.key_hash=? AND b.active=1 AND o.active=1",
          )
          .get(hashKey(key))) as
          | { id: string; org_id: string; name: string; plan: string; paid_until: number | null }
          | undefined)
      : undefined;
    if (!b) throw new HttpError(401, "llave_invalida");
    await db.prepare("UPDATE hq_branches SET last_seen=? WHERE id=?").run(Date.now(), b.id);
    return b;
  };

  /** Emite un código de activación nuevo para la sucursal; los anteriores sin usar dejan de valer. */
  const issueCode = async (branchId: string) => {
    const code = newCode();
    const expires = Date.now() + CODE_DAYS * 86_400_000;
    await db.transaction(async () => {
      await db
        .prepare("DELETE FROM hq_activation_codes WHERE branch_id=? AND used_at IS NULL")
        .run(branchId);
      await db
        .prepare(
          "INSERT INTO hq_activation_codes (id,branch_id,code_hash,expires_at,created_at) VALUES (?,?,?,?,?)",
        )
        .run(newId(), branchId, hashCode(code), expires, Date.now());
    })();
    return { code, expires_at: expires };
  };

  /** Licencia firmada de una sucursal, atada a la huella de su equipo. */
  const licenseFor = (
    b: { id: string; org_id: string; plan: string; paid_until?: number | null },
    fp: string | null,
  ) => {
    const plan = PLANS[b.plan] ?? PLANS.gratis!;
    const now = Date.now();
    const payload: LicensePayload = {
      org: b.org_id,
      branch: b.id,
      plan: b.plan,
      limits: { users: plan.users, printers: plan.printers },
      features: plan.features,
      iat: now,
      // Suscripción anual: la licencia vence el día hasta el que la organización está pagada; sin fecha, ventana corta (planes de prueba)
      exp: b.paid_until && b.paid_until > now ? b.paid_until : now + LICENSE_DAYS * 86_400_000,
      fp,
      kid: opts.keyId,
    };
    return signLicense(keys.priv, payload);
  };

  app.get("/api/hq/public-key", async () => ({ public_key: keys.pub }));

  // ---------- Plataforma ----------
  app.post("/api/hq/orgs", async (req, reply) => {
    if (!isPlatformAdmin(req)) throw new HttpError(401, "no_autenticado");
    const b = z
      .object({
        name: z.string().min(1),
        plan: z.enum(Object.keys(PLANS) as [string, ...string[]]).default("gratis"),
        paid_until: z.number().int().nullable().default(null),
        owner: z.object({ username: z.string().min(3), password: z.string().min(8) }),
      })
      .parse(req.body);
    const orgId = newId();
    await db.transaction(async () => {
      await db
        .prepare("INSERT INTO hq_orgs (id,name,plan,paid_until,created_at) VALUES (?,?,?,?,?)")
        .run(orgId, b.name, b.plan, b.paid_until, Date.now());
      await db
        .prepare(
          "INSERT INTO hq_users (id,org_id,username,password_hash,role) VALUES (?,?,?,?,'owner')",
        )
        .run(newId(), orgId, b.owner.username, hashSecret(b.owner.password));
    })();
    return reply.code(201).send({ id: orgId });
  });

  app.patch("/api/hq/orgs/:id", async (req) => {
    if (!isPlatformAdmin(req)) throw new HttpError(401, "no_autenticado");
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = z
      .object({
        plan: z.enum(Object.keys(PLANS) as [string, ...string[]]).optional(),
        active: z.boolean().optional(),
        /** Fecha (ms) hasta la que está pagada la suscripción anual; al renovar se avanza un año. */
        paid_until: z.number().int().nullable().optional(),
      })
      .parse(req.body);
    if (b.paid_until !== undefined)
      await db.prepare("UPDATE hq_orgs SET paid_until=? WHERE id=?").run(b.paid_until, id);
    if (b.plan) await db.prepare("UPDATE hq_orgs SET plan=? WHERE id=?").run(b.plan, id);
    if (b.active !== undefined)
      await db.prepare("UPDATE hq_orgs SET active=? WHERE id=?").run(b.active ? 1 : 0, id);
    return { ok: true };
  });

  // ---------- Organización ----------
  app.post("/api/hq/login", async (req, reply) => {
    const b = z.object({ username: z.string(), password: z.string() }).parse(req.body);
    const u = (await db
      .prepare(
        "SELECT u.id, u.org_id, u.role, u.password_hash, o.active FROM hq_users u JOIN hq_orgs o ON o.id=u.org_id WHERE u.username=?",
      )
      .get(b.username)) as
      | { id: string; org_id: string; role: string; password_hash: string; active: number }
      | undefined;
    if (!u?.active || !verifySecret(b.password, u.password_hash))
      return reply.code(401).send({ error: "credenciales_invalidas" });
    return { token: app.jwt.sign({ hq: true, org: u.org_id, sub: u.id, role: u.role } as never) };
  });

  app.get("/api/hq/me", async (req) => {
    const s = orgSession(req);
    const org = (await db.prepare("SELECT id, name, plan FROM hq_orgs WHERE id=?").get(s.org)) as {
      id: string;
      name: string;
      plan: string;
    };
    return {
      ...org,
      role: s.role,
      limits: PLANS[org.plan],
      branches_used: (
        (await db
          .prepare("SELECT COUNT(*) c FROM hq_branches WHERE org_id=? AND active=1")
          .get(s.org)) as { c: number }
      ).c,
    };
  });

  app.post("/api/hq/branches", async (req, reply) => {
    const s = owner(req);
    const { name } = z.object({ name: z.string().min(1) }).parse(req.body);
    const org = (await db.prepare("SELECT plan FROM hq_orgs WHERE id=?").get(s.org)) as {
      plan: string;
    };
    const limit = PLANS[org.plan]?.branches ?? null;
    const used = (
      (await db
        .prepare("SELECT COUNT(*) c FROM hq_branches WHERE org_id=? AND active=1")
        .get(s.org)) as { c: number }
    ).c;
    if (limit !== null && used >= limit)
      throw new HttpError(402, "limite_plan", `Tu plan ${org.plan} permite ${limit} sucursal(es)`);
    const id = newId();
    const key = `bk_${randomBytes(24).toString("hex")}`;
    await db
      .prepare("INSERT INTO hq_branches (id,org_id,name,key_hash,created_at) VALUES (?,?,?,?,?)")
      .run(id, s.org, name, hashKey(key), Date.now());
    // La llave se muestra una sola vez. El código de activación es lo que se lleva al local: al canjearlo, el HQ entrega
    // una llave nueva directo al equipo (la llave de aquí queda para quien integre sin activar).
    const activation = await issueCode(id);
    return reply.code(201).send({
      id,
      api_key: key,
      activation_code: activation.code,
      activation_expires_at: activation.expires_at,
    });
  });

  app.get("/api/hq/branches", async (req) => {
    const s = orgSession(req);
    const rows = (await db
      .prepare(
        `SELECT b.id, b.name, b.last_seen, b.active, b.created_at, b.activated_at, b.fingerprint,
                (SELECT COUNT(*) FROM hq_backups k WHERE k.branch_id=b.id) AS backups,
                (SELECT MAX(k.created_at) FROM hq_backups k WHERE k.branch_id=b.id) AS last_backup,
                (SELECT COALESCE(SUM(k.size),0) FROM hq_backups k WHERE k.branch_id=b.id) AS backup_bytes
         FROM hq_branches b WHERE b.org_id=? ORDER BY b.name`,
      )
      .all(s.org)) as { fingerprint: string | null }[];
    // La huella completa no sale del HQ; se muestra una forma corta para atender un cambio de equipo
    return rows.map(({ fingerprint, ...r }) => ({
      ...r,
      backup_quota_bytes: quota,
      activated: !!fingerprint,
      fingerprint_short: fingerprint ? shortFingerprint(fingerprint) : null,
    }));
  });

  app.patch("/api/hq/branches/:id", async (req) => {
    const s = owner(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    const r = await db
      .prepare("UPDATE hq_branches SET active=? WHERE id=? AND org_id=?")
      .run(active ? 1 : 0, id, s.org);
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
              products: z
                .array(
                  z.object({
                    product: z.string(),
                    units: z.number().int(),
                    sales_cents: z.number().int(),
                  }),
                )
                .max(500)
                .default([]),
            }),
          )
          .max(62),
      })
      .parse(req.body);
    await db.transaction(async () => {
      for (const d of body.days) {
        await db
          .prepare(
            `INSERT INTO hq_sales (branch_id,day,tickets,sales_cents,tips_cents,discounts_cents,cancelled_items) VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(branch_id,day) DO UPDATE SET tickets=excluded.tickets, sales_cents=excluded.sales_cents, tips_cents=excluded.tips_cents, discounts_cents=excluded.discounts_cents, cancelled_items=excluded.cancelled_items`,
          )
          .run(
            b.id,
            d.day,
            d.tickets,
            d.sales_cents,
            d.tips_cents,
            d.discounts_cents,
            d.cancelled_items,
          );
        await db
          .prepare("DELETE FROM hq_product_sales WHERE branch_id=? AND day=?")
          .run(b.id, d.day);
        for (const p of d.products)
          await db
            .prepare(
              "INSERT INTO hq_product_sales (branch_id,day,product,units,sales_cents) VALUES (?,?,?,?,?)",
            )
            .run(b.id, d.day, p.product, p.units, p.sales_cents);
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
    const perBranch = (await db
      .prepare(
        `SELECT b.id, b.name, COALESCE(SUM(s.tickets),0) tickets, COALESCE(SUM(s.sales_cents),0) sales_cents, COALESCE(SUM(s.tips_cents),0) tips_cents,
                COALESCE(SUM(s.discounts_cents),0) discounts_cents, COALESCE(SUM(s.cancelled_items),0) cancelled_items
         FROM hq_branches b LEFT JOIN hq_sales s ON s.branch_id=b.id AND s.day>=? AND s.day<=?
         WHERE b.org_id=? GROUP BY b.id ORDER BY sales_cents DESC`,
      )
      .all(from, to, s.org)) as { tickets: number; sales_cents: number; tips_cents: number }[];
    const total = perBranch.reduce(
      (a, r) => ({
        tickets: a.tickets + r.tickets,
        sales_cents: a.sales_cents + r.sales_cents,
        tips_cents: a.tips_cents + r.tips_cents,
      }),
      { tickets: 0, sales_cents: 0, tips_cents: 0 },
    );
    const byDay = await db
      .prepare(
        `SELECT s.day, SUM(s.tickets) tickets, SUM(s.sales_cents) sales_cents FROM hq_sales s JOIN hq_branches b ON b.id=s.branch_id
         WHERE b.org_id=? AND s.day>=? AND s.day<=? GROUP BY s.day ORDER BY s.day`,
      )
      .all(s.org, from, to);
    return {
      branches: perBranch,
      total: {
        ...total,
        average_ticket_cents: total.tickets ? Math.round(total.sales_cents / total.tickets) : 0,
      },
      by_day: byDay,
    };
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
    const rows = (await db
      .prepare(
        "SELECT sku, name, price_cents, category, station_names, active FROM hq_catalog WHERE org_id=? ORDER BY name",
      )
      .all(orgId)) as { station_names: string }[];
    return rows.map((r) => ({ ...r, station_names: JSON.parse(r.station_names) as string[] }));
  };

  app.get("/api/hq/catalog", async (req) => {
    const orgId = req.headers["x-branch-key"]
      ? (await branchSession(req)).org_id
      : orgSession(req).org;
    return catalogRows(orgId);
  });

  app.put("/api/hq/catalog", async (req) => {
    const s = owner(req);
    const b = z
      .object({
        products: z
          .array(
            z.object({
              sku: z.string().min(1),
              name: z.string().min(1),
              price_cents: z.number().int().min(0),
              category: z.string().nullable().optional(),
              station_names: z.array(z.string()).default([]),
              active: z.boolean().default(true),
            }),
          )
          .max(2000),
      })
      .parse(req.body);
    await db.transaction(async () => {
      for (const p of b.products) {
        await db
          .prepare(
            `INSERT INTO hq_catalog (id,org_id,sku,name,price_cents,category,station_names,active) VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(org_id,sku) DO UPDATE SET name=excluded.name, price_cents=excluded.price_cents, category=excluded.category, station_names=excluded.station_names, active=excluded.active`,
          )
          .run(
            newId(),
            s.org,
            p.sku,
            p.name,
            p.price_cents,
            p.category ?? null,
            JSON.stringify(p.station_names),
            p.active ? 1 : 0,
          );
      }
    })();
    return { ok: true, products: b.products.length };
  });

  // ---------- Licencia ----------
  app.get("/api/hq/license", async (req) => {
    const b = await branchSession(req);
    const row = (await db.prepare("SELECT fingerprint FROM hq_branches WHERE id=?").get(b.id)) as {
      fingerprint: string | null;
    };
    const asked = String(req.headers["x-device-fp"] ?? "");
    // Una sucursal activada solo recibe licencia para su equipo: otra huella exige un código nuevo
    if (row.fingerprint && asked !== row.fingerprint)
      throw new HttpError(403, "equipo_distinto", "Esta sucursal está activada en otro equipo");
    return { token: licenseFor(b, row.fingerprint), plan: b.plan };
  });

  // ---------- Respaldos cifrados (plan 04) ----------
  // El cuerpo llega como flujo (no se carga en memoria): se cuenta, se resume con SHA-256 y se verifica contra lo declarado
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) =>
    done(null, payload),
  );
  const maxBytes = opts.backupMaxBytes ?? 512 * 1024 * 1024;
  const quota = opts.branchQuotaBytes ?? 5 * 1024 * 1024 * 1024;
  const NAME = /^[A-Za-z0-9._-]{6,80}\.nbk$/;

  /** Sucursal autenticada, activada y desde el equipo con el que se activó. */
  const backupBranch = async (req: FastifyRequest) => {
    if (!opts.backupStoreDir)
      throw new HttpError(501, "respaldo_no_disponible", "Este servidor no guarda respaldos");
    const b = await branchSession(req);
    const row = (await db.prepare("SELECT fingerprint FROM hq_branches WHERE id=?").get(b.id)) as {
      fingerprint: string | null;
    };
    if (!row.fingerprint || String(req.headers["x-device-fp"] ?? "") !== row.fingerprint)
      throw new HttpError(403, "equipo_distinto", "Esta sucursal no está activada en este equipo");
    return b;
  };
  const storePath = (branchId: string, name: string) =>
    join(opts.backupStoreDir as string, branchId, name);

  /** 14 recientes + el más reciente de cada uno de los 6 meses anteriores; lo demás se borra. */
  const retention = (rows: { name: string; created_at: number }[]) => {
    // Misma hora: el nombre lleva la marca de tiempo, así que el mayor es el más reciente
    const sorted = [...rows].sort(
      (a, b) => b.created_at - a.created_at || (a.name < b.name ? 1 : -1),
    );
    const keep = new Set(sorted.slice(0, 14).map((r) => r.name));
    const months = new Set<string>();
    for (const r of sorted.slice(14)) {
      const m = new Date(r.created_at).toISOString().slice(0, 7);
      if (!months.has(m) && months.size < 6) {
        months.add(m);
        keep.add(r.name);
      }
    }
    return sorted.filter((r) => !keep.has(r.name)).map((r) => r.name);
  };

  app.put("/api/hq/backups/:name", async (req, reply) => {
    const b = await backupBranch(req);
    const { name } = z.object({ name: z.string().regex(NAME) }).parse(req.params);
    const sha = z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .parse(String(req.headers["x-sha256"] ?? ""));
    const declared = Number(req.headers["content-length"]);
    if (!Number.isFinite(declared) || declared <= 0)
      throw new HttpError(411, "falta_tamano", "Falta el tamaño del respaldo");
    if (declared > maxBytes)
      throw new HttpError(
        413,
        "respaldo_demasiado_grande",
        `El respaldo supera el máximo de ${maxBytes} bytes`,
      );
    const used = (
      (await db
        .prepare("SELECT COALESCE(SUM(size),0) s FROM hq_backups WHERE branch_id=? AND name<>?")
        .get(b.id, name)) as { s: number }
    ).s;
    if (used + declared > quota)
      throw new HttpError(
        413,
        "cuota_excedida",
        "La sucursal llegó al espacio de respaldos de su plan",
      );

    const dir = join(opts.backupStoreDir as string, b.id);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.subiendo-${randomBytes(6).toString("hex")}`);
    const hash = createHash("sha256");
    let size = 0;
    const out = createWriteStream(tmp);
    try {
      for await (const chunk of req.body as Readable) {
        size += (chunk as Buffer).length;
        if (size > declared || size > maxBytes)
          throw new HttpError(413, "respaldo_demasiado_grande");
        hash.update(chunk as Buffer);
        if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
      }
      await new Promise<void>((r) => out.end(() => r()));
      if (size !== declared)
        throw new HttpError(400, "subida_incompleta", "La subida se cortó antes de terminar");
      if (hash.digest("hex") !== sha)
        throw new HttpError(
          422,
          "suma_no_coincide",
          "El respaldo llegó alterado (la suma no coincide)",
        );
      renameSync(tmp, storePath(b.id, name));
    } catch (e) {
      out.destroy();
      rmSync(tmp, { force: true });
      throw e;
    }
    await db.transaction(async () => {
      await db.prepare("DELETE FROM hq_backups WHERE branch_id=? AND name=?").run(b.id, name);
      await db
        .prepare(
          "INSERT INTO hq_backups (id,branch_id,name,size,sha256,created_at) VALUES (?,?,?,?,?,?)",
        )
        .run(newId(), b.id, name, size, sha, Date.now());
    })();
    const all = (await db
      .prepare("SELECT name, created_at FROM hq_backups WHERE branch_id=?")
      .all(b.id)) as { name: string; created_at: number }[];
    const drop = retention(all);
    for (const old of drop) {
      await db.prepare("DELETE FROM hq_backups WHERE branch_id=? AND name=?").run(b.id, old);
      rmSync(storePath(b.id, old), { force: true });
    }
    return reply.code(201).send({ ok: true, name, size, kept: all.length - drop.length });
  });

  app.get("/api/hq/backups", async (req) => {
    const b = await backupBranch(req);
    return db
      .prepare(
        "SELECT name, size, sha256, created_at FROM hq_backups WHERE branch_id=? ORDER BY created_at DESC",
      )
      .all(b.id);
  });

  app.get("/api/hq/backups/:name", async (req, reply) => {
    const b = await backupBranch(req);
    const { name } = z.object({ name: z.string().regex(NAME) }).parse(req.params);
    const row = (await db
      .prepare("SELECT size, sha256 FROM hq_backups WHERE branch_id=? AND name=?")
      .get(b.id, name)) as { size: number; sha256: string } | undefined;
    if (!row) throw new HttpError(404, "no_encontrado");
    reply.header("content-type", "application/octet-stream");
    reply.header("content-length", String(statSync(storePath(b.id, name)).size));
    reply.header("x-sha256", row.sha256);
    return reply.send(createReadStream(storePath(b.id, name)));
  });

  /** El propietario ve qué respaldos tiene cada una de sus sucursales (sin poder leerlos: están cifrados). */
  app.get("/api/hq/branches/:id/backups", async (req) => {
    const s = owner(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const br = (await db.prepare("SELECT org_id FROM hq_branches WHERE id=?").get(id)) as
      | { org_id: string }
      | undefined;
    if (!br || br.org_id !== s.org) throw new HttpError(404, "no_encontrado");
    return db
      .prepare(
        "SELECT name, size, created_at FROM hq_backups WHERE branch_id=? ORDER BY created_at DESC",
      )
      .all(id);
  });

  /** Un respaldo de una sucursal de la organización del propietario (cifrado: el HQ no puede leerlo). */
  const ownedBackup = async (req: FastifyRequest) => {
    if (!opts.backupStoreDir)
      throw new HttpError(501, "respaldo_no_disponible", "Este servidor no guarda respaldos");
    const s = owner(req);
    const p = z.object({ id: z.string(), name: z.string().regex(NAME) }).parse(req.params);
    const row = (await db
      .prepare(
        "SELECT k.size, k.sha256 FROM hq_backups k JOIN hq_branches b ON b.id=k.branch_id WHERE k.branch_id=? AND k.name=? AND b.org_id=?",
      )
      .get(p.id, p.name, s.org)) as { size: number; sha256: string } | undefined;
    if (!row) throw new HttpError(404, "no_encontrado");
    return { branchId: p.id, name: p.name, row };
  };

  // Descarga del texto cifrado (p. ej. para guardarlo aparte o llevarlo a una PC nueva a mano)
  app.get("/api/hq/branches/:id/backups/:name", async (req, reply) => {
    const { branchId, name, row } = await ownedBackup(req);
    reply.header("content-type", "application/octet-stream");
    reply.header("content-disposition", `attachment; filename="${name}"`);
    reply.header("content-length", String(statSync(storePath(branchId, name)).size));
    reply.header("x-sha256", row.sha256);
    return reply.send(createReadStream(storePath(branchId, name)));
  });

  // Borrado definitivo de un respaldo (libera espacio de la cuota)
  app.delete("/api/hq/branches/:id/backups/:name", async (req) => {
    const { branchId, name } = await ownedBackup(req);
    await db.prepare("DELETE FROM hq_backups WHERE branch_id=? AND name=?").run(branchId, name);
    rmSync(storePath(branchId, name), { force: true });
    return { ok: true };
  });

  // ---------- Activación (plan 03) ----------
  /** Código nuevo para una sucursal (cambio de equipo o código perdido). La plataforma puede hacerlo para cualquiera. */
  app.post("/api/hq/branches/:id/activation-code", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const platform = isPlatformAdmin(req);
    const orgId = platform ? null : owner(req).org;
    const branch = (await db.prepare("SELECT id, org_id FROM hq_branches WHERE id=?").get(id)) as
      | { id: string; org_id: string }
      | undefined;
    if (!branch || (orgId && branch.org_id !== orgId)) throw new HttpError(404, "no_encontrado");
    return issueCode(id);
  });

  /**
   * Canje del código desde el local (público: el código es la credencial). Un solo uso: ata la sucursal a la huella
   * del equipo, rota la llave de la sucursal y devuelve la llave nueva y la licencia firmada.
   */
  app.post("/api/hq/activate", async (req) => {
    if (tooMany(req.ip)) throw new HttpError(429, "demasiados_intentos", "Espera unos minutos");
    const b = z
      .object({
        code: z.string().min(8).max(40),
        fingerprint: z.string().regex(/^[0-9a-f]{32}$/),
        device: z.string().max(80).optional(),
      })
      .parse(req.body);
    const invalid = () =>
      new HttpError(404, "codigo_invalido", "Código inválido, ya usado o vencido");
    const apiKey = `bk_${randomBytes(24).toString("hex")}`;
    let result: {
      branch: { id: string; org_id: string; plan: string; name: string; org: string };
    } | null = null;
    await db.transaction(async () => {
      const c = (await db
        .prepare(
          "SELECT id, branch_id, expires_at, used_at FROM hq_activation_codes WHERE code_hash=?",
        )
        .get(hashCode(b.code))) as
        | { id: string; branch_id: string; expires_at: number; used_at: number | null }
        | undefined;
      if (!c || c.used_at || c.expires_at < Date.now()) return;
      const br = (await db
        .prepare(
          "SELECT b.id, b.org_id, b.name, o.plan, o.paid_until, o.name AS org FROM hq_branches b JOIN hq_orgs o ON o.id=b.org_id WHERE b.id=? AND b.active=1 AND o.active=1",
        )
        .get(c.branch_id)) as
        | {
            id: string;
            org_id: string;
            plan: string;
            name: string;
            org: string;
            paid_until: number | null;
          }
        | undefined;
      if (!br) return;
      const used = await db
        .prepare("UPDATE hq_activation_codes SET used_at=? WHERE id=? AND used_at IS NULL")
        .run(Date.now(), c.id);
      if (used.changes === 0) return; // otra solicitud lo canjeó primero
      await db
        .prepare("UPDATE hq_branches SET fingerprint=?, activated_at=?, key_hash=? WHERE id=?")
        .run(b.fingerprint, Date.now(), hashKey(apiKey), br.id);
      await db
        .prepare(
          "INSERT INTO hq_activations (id,branch_id,fingerprint,device,ip,created_at) VALUES (?,?,?,?,?,?)",
        )
        .run(newId(), br.id, b.fingerprint, b.device ?? null, req.ip, Date.now());
      result = { branch: br };
    })();
    if (!result) throw invalid();
    const { branch } = result as {
      branch: { id: string; org_id: string; plan: string; name: string; org: string };
    };
    return {
      api_key: apiKey,
      token: licenseFor(branch, b.fingerprint),
      plan: branch.plan,
      org: branch.org,
      branch: branch.name,
    };
  });
}
