import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { permissionsFor } from "../perms";
import { audit, jwtSecret } from "../db";
import { HttpError } from "../domain";

const CALL_COOLDOWN_MS = 20_000;

/** Token firmado por mesa (el QR lleva `mesaId.firma`): sin sesión, pero imposible de falsificar. */
export function qrToken(secret: string, tableId: string): string {
  return `${tableId}.${createHmac("sha256", secret).update(`qr:${tableId}`).digest("hex").slice(0, 32)}`;
}

export function verifyQrToken(secret: string, token: string): string | null {
  const [tableId, sig] = token.split(".");
  if (!tableId || !sig) return null;
  const expected = Buffer.from(qrToken(secret, tableId).split(".")[1]!);
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected) ? tableId : null;
}

/** Menú QR (Fase 2, sec. 51): ver menú, pedir, llamar al mesero y pedir la cuenta. */
export async function publicRoutes(app: FastifyInstance) {
  const { db, hub } = app;
  const secret = jwtSecret(db);
  const lastCall = new Map<string, number>();

  const tableFor = (token: string) => {
    const tableId = verifyQrToken(secret, token);
    const t = tableId ? (db.prepare("SELECT id, number FROM tables_ WHERE id=?").get(tableId) as { id: string; number: string } | undefined) : undefined;
    if (!t) throw new HttpError(401, "qr_invalido");
    return t;
  };
  const openAccount = (tableId: string) =>
    db.prepare("SELECT id, waiter_id FROM accounts WHERE table_id=? AND status='abierta' ORDER BY opened_at LIMIT 1").get(tableId) as { id: string; waiter_id: string } | undefined;

  // Genera el enlace del QR de una mesa (el administrador lo imprime)
  app.get("/api/tables/:id/qr", { preHandler: app.authorize("venue.manage") }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    if (!db.prepare("SELECT 1 FROM tables_ WHERE id=?").get(id)) throw new HttpError(404, "no_encontrado");
    return { path: `/m?t=${qrToken(secret, id)}` };
  });

  app.get("/api/public/menu", async (req) => {
    const { t } = z.object({ t: z.string() }).parse(req.query);
    const table = tableFor(t);
    const products = db
      .prepare("SELECT id, category_id, name, description, price_cents, availability, photo FROM products WHERE active=1 ORDER BY name")
      .all() as { id: string }[];
    const links = db.prepare("SELECT * FROM product_modifier_groups").all() as { product_id: string; group_id: string }[];
    const mods = db.prepare("SELECT id, group_id, name, price_cents FROM modifiers").all() as { group_id: string }[];
    return {
      table: { number: table.number },
      can_order: !!openAccount(table.id),
      categories: db.prepare("SELECT id, parent_id, name FROM categories ORDER BY sort, name").all(),
      products: products.map((p) => ({ ...p, modifier_group_ids: links.filter((l) => l.product_id === p.id).map((l) => l.group_id) })),
      groups: (db.prepare("SELECT id, name, required, multiple, max_select FROM modifier_groups").all() as { id: string }[]).map((g) => ({ ...g, modifiers: mods.filter((m) => m.group_id === g.id) })),
    };
  });

  app.post("/api/public/call", async (req, reply) => {
    const b = z.object({ t: z.string(), reason: z.enum(["mesero", "cuenta"]) }).parse(req.body);
    const table = tableFor(b.t);
    const key = `${table.id}:${b.reason}`;
    if (Date.now() - (lastCall.get(key) ?? 0) < CALL_COOLDOWN_MS) throw new HttpError(429, "espera_un_momento", "Ya avisamos al mesero, un momento por favor");
    lastCall.set(key, Date.now());
    audit(db, null, `qr_${b.reason}`, "table", table.id);
    hub.emit({ type: "waiter.called", tableId: table.id, tableNumber: table.number, reason: b.reason });
    return reply.code(202).send({ ok: true });
  });

  // El pedido entra por el flujo normal de comandas, atribuido al mesero de la cuenta abierta
  app.post("/api/public/order", async (req, reply) => {
    const b = z
      .object({
        t: z.string(),
        items: z.array(z.object({ productId: z.string(), quantity: z.number().int().min(1).max(5).default(1), modifierIds: z.array(z.string()).default([]), note: z.string().max(120).optional() })).min(1).max(10),
      })
      .parse(req.body);
    const table = tableFor(b.t);
    const acc = openAccount(table.id);
    if (!acc) throw new HttpError(409, "sin_cuenta_abierta", "Pide al mesero que abra tu mesa para ordenar");
    const waiter = db.prepare("SELECT id, role FROM users WHERE id=?").get(acc.waiter_id) as { id: string; role: Parameters<typeof permissionsFor>[0] };
    const token = app.jwt.sign({ sub: waiter.id, role: waiter.role, permissions: permissionsFor(waiter.role) });
    const res = await app.inject({ method: "POST", url: `/api/accounts/${acc.id}/orders`, headers: { Authorization: `Bearer ${token}` }, payload: { items: b.items } });
    if (res.statusCode >= 400) return reply.code(res.statusCode).send(res.json());
    const { id: orderId } = res.json() as { id: string };
    db.prepare("UPDATE orders SET source='qr' WHERE id=?").run(orderId);
    audit(db, null, "pedido_qr", "order", orderId, { table: table.number });
    return reply.code(201).send({ ok: true });
  });
}
