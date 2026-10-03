import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, newId } from "../db";
import { HttpError } from "../domain";
import { permissionsFor } from "../perms";
import { WEBHOOK_EVENTS } from "../webhooks";

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** Integraciones (Fase 3, sec. 50): pedidos entrantes por API con llave y webhooks salientes firmados. */
export async function integrationRoutes(app: FastifyInstance) {
  const { db } = app;
  const id = z.object({ id: z.string() });

  // ---------- Administración (user.manage) ----------
  app.get("/api/integrations", { preHandler: app.authorize("user.manage") }, async () =>
    db.prepare("SELECT id, name, kind, active, created_at FROM integrations ORDER BY name").all(),
  );

  app.post(
    "/api/integrations",
    { preHandler: app.authorize("user.manage") },
    async (req, reply) => {
      const b = z
        .object({
          name: z.string().min(1),
          kind: z.enum(["web", "whatsapp", "delivery_app", "otro"]),
        })
        .parse(req.body);
      const iid = newId();
      const key = `ik_${randomBytes(24).toString("hex")}`;
      await db
        .prepare("INSERT INTO integrations (id,name,kind,key_hash,created_at) VALUES (?,?,?,?,?)")
        .run(iid, b.name, b.kind, hashKey(key), Date.now());
      await audit(db, req.user.sub, "crear", "integracion", iid, { name: b.name });
      // La llave solo se muestra una vez
      return reply.code(201).send({ id: iid, api_key: key });
    },
  );

  app.patch("/api/integrations/:id", { preHandler: app.authorize("user.manage") }, async (req) => {
    const { id: iid } = id.parse(req.params);
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    const r = await db
      .prepare("UPDATE integrations SET active=? WHERE id=?")
      .run(active ? 1 : 0, iid);
    if (r.changes === 0) throw new HttpError(404, "no_encontrado");
    await audit(db, req.user.sub, active ? "activar" : "desactivar", "integracion", iid);
    return { ok: true };
  });

  // ---------- Webhooks salientes ----------
  app.get("/api/webhooks", { preHandler: app.authorize("user.manage") }, async () =>
    db
      .prepare(
        `SELECT e.id, e.url, e.events, e.active,
              (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.endpoint_id=e.id AND d.status='error') AS failed,
              (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.endpoint_id=e.id AND d.status='pendiente') AS pending
       FROM webhook_endpoints e ORDER BY e.rowid`,
      )
      .all(),
  );

  app.post("/api/webhooks", { preHandler: app.authorize("user.manage") }, async (req, reply) => {
    const b = z
      .object({
        url: z
          .string()
          .url()
          .refine((u) => /^https?:\/\//.test(u), "Solo http o https"),
        events: z.array(z.enum(WEBHOOK_EVENTS)).default([]),
      })
      .parse(req.body);
    const wid = newId();
    const secret = `whsec_${randomBytes(24).toString("hex")}`;
    await db
      .prepare("INSERT INTO webhook_endpoints (id,url,secret,events) VALUES (?,?,?,?)")
      .run(wid, b.url, secret, b.events.length ? b.events.join(",") : "*");
    await audit(db, req.user.sub, "crear", "webhook", wid, { url: b.url });
    return reply.code(201).send({ id: wid, secret });
  });

  app.delete("/api/webhooks/:id", { preHandler: app.authorize("user.manage") }, async (req) => {
    const { id: wid } = id.parse(req.params);
    const r = await db.prepare("DELETE FROM webhook_endpoints WHERE id=?").run(wid);
    if (r.changes === 0) throw new HttpError(404, "no_encontrado");
    await audit(db, req.user.sub, "eliminar", "webhook", wid);
    return { ok: true };
  });

  app.get("/api/webhooks/deliveries", { preHandler: app.authorize("user.manage") }, async (req) => {
    const { status } = z
      .object({ status: z.enum(["pendiente", "enviado", "error"]).optional() })
      .parse(req.query);
    return db
      .prepare(
        `SELECT id, endpoint_id, event, status, attempts, last_error, created_at FROM webhook_deliveries ${status ? "WHERE status=?" : ""} ORDER BY created_at DESC LIMIT 100`,
      )
      .all(...(status ? [status] : []));
  });

  app.post(
    "/api/webhooks/deliveries/:id/retry",
    { preHandler: app.authorize("user.manage") },
    async (req) => {
      const { id: did } = id.parse(req.params);
      const r = await db
        .prepare(
          "UPDATE webhook_deliveries SET status='pendiente', attempts=0, next_attempt_at=? WHERE id=? AND status='error'",
        )
        .run(Date.now(), did);
      if (r.changes === 0) throw new HttpError(404, "no_encontrado");
      return { ok: true };
    },
  );

  // ---------- Entrada de pedidos (autenticada con la llave de la integración) ----------
  const integrationFor = async (header: unknown) => {
    const key = typeof header === "string" ? header : "";
    const row = key
      ? ((await db
          .prepare("SELECT id, name FROM integrations WHERE key_hash=? AND active=1")
          .get(hashKey(key))) as { id: string; name: string } | undefined)
      : undefined;
    if (!row) throw new HttpError(401, "llave_invalida");
    return row;
  };

  // Usuario técnico (sin acceso por PIN ni contraseña) que aparece como responsable de los pedidos externos
  const systemUser = async (name: string) => {
    const label = `Integración: ${name}`;
    const found = (await db.prepare("SELECT id FROM users WHERE name=? AND active=0").get(label)) as
      | { id: string }
      | undefined;
    if (found) return found.id;
    const uid = newId();
    await db
      .prepare("INSERT INTO users (id,name,role,active,created_at) VALUES (?,?,?,?,?)")
      .run(uid, label, "mesero", 0, Date.now());
    return uid;
  };

  const orderBody = z.object({
    external_ref: z.string().min(1).max(80),
    kind: z.enum(["delivery", "llevar"]).default("delivery"),
    customer: z.object({
      name: z.string().min(1),
      phone: z.string().optional(),
      address: z.string().optional(),
    }),
    fee_cents: z.number().int().min(0).default(0),
    notes: z.string().optional(),
    items: z
      .array(
        z.object({
          sku: z.string().min(1),
          quantity: z.number().int().min(1).max(99).default(1),
          note: z.string().max(200).optional(),
        }),
      )
      .min(1)
      .max(50),
  });

  app.post("/api/integrations/orders", async (req, reply) => {
    const integ = await integrationFor(req.headers["x-api-key"]);
    const b = orderBody.parse(req.body);

    // Idempotencia: la misma referencia externa no crea dos pedidos
    const dup = (await db
      .prepare("SELECT a.id, a.label FROM accounts a WHERE a.integration_id=? AND a.external_ref=?")
      .get(integ.id, b.external_ref)) as { id: string; label: string } | undefined;
    if (dup) return reply.code(200).send({ id: dup.id, label: dup.label, duplicate: true });

    // Los productos se identifican por SKU
    const unknown: string[] = [];
    const items: { productId: string; quantity: number; note: string | undefined }[] = [];
    for (const it of b.items) {
      const p = (await db
        .prepare("SELECT id FROM products WHERE sku=? AND active=1")
        .get(it.sku)) as { id: string } | undefined;
      if (!p) unknown.push(it.sku);
      items.push({ productId: p?.id ?? "", quantity: it.quantity, note: it.note });
    }
    if (unknown.length)
      throw new HttpError(422, "sku_desconocido", `SKU no encontrados: ${unknown.join(", ")}`);

    const uid = await systemUser(integ.name);
    const token = app.jwt.sign({ sub: uid, role: "mesero", permissions: permissionsFor("mesero") });
    const headers = { Authorization: `Bearer ${token}` };

    const created = await app.inject({
      method: "POST",
      url: "/api/orders/external",
      headers,
      payload: {
        kind: b.kind,
        contact_name: b.customer.name,
        phone: b.customer.phone,
        address: b.kind === "delivery" ? (b.customer.address ?? "Sin dirección") : undefined,
        fee_cents: b.kind === "delivery" ? b.fee_cents : 0,
        notes: b.notes,
      },
    });
    if (created.statusCode >= 400) return reply.code(created.statusCode).send(created.json());
    const acc = created.json() as { id: string; label: string };
    await db
      .prepare("UPDATE accounts SET integration_id=?, external_ref=? WHERE id=?")
      .run(integ.id, b.external_ref, acc.id);

    const sent = await app.inject({
      method: "POST",
      url: `/api/accounts/${acc.id}/orders`,
      headers,
      payload: { items },
    });
    if (sent.statusCode >= 400) {
      // Sin comanda no hay pedido: se deshace la cuenta para que el cliente pueda reintentar con la misma referencia
      await db.prepare("DELETE FROM delivery_info WHERE account_id=?").run(acc.id);
      await db.prepare("DELETE FROM accounts WHERE id=?").run(acc.id);
      return reply.code(sent.statusCode).send(sent.json());
    }
    await db
      .prepare("UPDATE orders SET source=? WHERE account_id=?")
      .run(`api:${integ.name}`, acc.id);
    await audit(db, null, "pedido_externo", "account", acc.id, {
      integration: integ.name,
      ref: b.external_ref,
    });
    return reply.code(201).send({ id: acc.id, label: acc.label });
  });

  // Estado del pedido para que el sistema externo consulte
  app.get("/api/integrations/orders/:ref", async (req) => {
    const integ = await integrationFor(req.headers["x-api-key"]);
    const { ref } = z.object({ ref: z.string() }).parse(req.params);
    const row = await db
      .prepare(
        `SELECT a.id, a.label, a.status AS account_status, d.status, d.driver, d.eta FROM accounts a LEFT JOIN delivery_info d ON d.account_id=a.id
         WHERE a.integration_id=? AND a.external_ref=?`,
      )
      .get(integ.id, ref);
    if (!row) throw new HttpError(404, "no_encontrado");
    return row;
  });
}
