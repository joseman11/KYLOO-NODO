import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, newId } from "../db";
import { HttpError, accountTotal } from "../domain";

const NEXT: Record<string, string[]> = {
  recibido: ["preparando", "listo", "cancelado"],
  preparando: ["listo", "cancelado"],
  listo: ["en_camino", "entregado", "cancelado"],
  en_camino: ["entregado", "cancelado"],
  entregado: [],
  cancelado: [],
};

/** Pedidos para llevar y delivery (Fase 2, sec. 48 y 49): cuentas sin mesa que usan el mismo motor de comandas. */
export async function deliveryRoutes(app: FastifyInstance) {
  const { db, hub } = app;

  app.post("/api/orders/external", { preHandler: app.authorize("order.create") }, async (req, reply) => {
    const b = z
      .object({
        kind: z.enum(["llevar", "delivery"]),
        contact_name: z.string().min(1),
        phone: z.string().optional(),
        address: z.string().optional(),
        zone: z.string().optional(),
        fee_cents: z.number().int().min(0).default(0),
        eta: z.number().int().optional(),
        notes: z.string().optional(),
        customer_id: z.string().nullable().optional(),
      })
      .parse(req.body);
    if (b.kind === "delivery" && !b.address) throw new HttpError(400, "validacion", "El delivery requiere dirección");
    if (b.kind === "llevar" && b.fee_cents) throw new HttpError(400, "validacion", "Para llevar no lleva costo de envío");

    const accountId = newId();
    const today = new Date().setHours(0, 0, 0, 0);
    let label = "";
    await db.transaction(async () => {
            // Folio visible por día: L1, L2… / D1, D2…
            const n = (await db.prepare("SELECT COUNT(*) c FROM accounts WHERE kind=? AND opened_at>=?").get(b.kind, today) as { c: number }).c + 1;
            label = `${b.kind === "llevar" ? "L" : "D"}${n}`;
            await db.prepare("INSERT INTO accounts (id,table_id,kind,label,customer_id,waiter_id,opened_by,opened_at) VALUES (?,?,?,?,?,?,?,?)").run(
                      accountId, null, b.kind, label, b.customer_id ?? null, req.user.sub, req.user.sub, Date.now(),
                    );
            await db.prepare("INSERT INTO delivery_info (account_id,contact_name,phone,address,zone,fee_cents,eta,notes) VALUES (?,?,?,?,?,?,?,?)").run(
                      accountId, b.contact_name, b.phone ?? null, b.address ?? null, b.zone ?? null, b.fee_cents, b.eta ?? null, b.notes ?? null,
                    );
          })();
    await audit(db, req.user.sub, `crear_${b.kind}`, "account", accountId, { label, contact: b.contact_name });
    hub.emit({ type: "delivery.updated", accountId, status: "recibido" });
    return reply.code(201).send({ id: accountId, label });
  });

  app.get("/api/delivery", { preHandler: app.authorize() }, async (req) => {
    const { all } = z.object({ all: z.coerce.boolean().default(false) }).parse(req.query);
    const rows = await db
          .prepare(
            `SELECT a.id, a.kind, a.label, a.status AS account_status, a.opened_at, d.* , u.name AS waiter
         FROM delivery_info d JOIN accounts a ON a.id=d.account_id JOIN users u ON u.id=a.waiter_id
         ${all ? "" : "WHERE d.status NOT IN ('entregado','cancelado') OR a.status!='cerrada'"} ORDER BY a.opened_at DESC LIMIT 100`,
          )
          .all() as { id: string }[];
    return Promise.all(rows.map(async (r) => ({ ...r, total_cents: await accountTotal(db, r.id) })));
  });

  app.post("/api/delivery/:id/status", { preHandler: app.authorize("order.create") }, async (req) => {
    const { id: accountId } = z.object({ id: z.string() }).parse(req.params);
    const b = z.object({ status: z.enum(["preparando", "listo", "en_camino", "entregado", "cancelado"]), driver: z.string().optional(), reason: z.string().optional() }).parse(req.body);
    const info = await db.prepare("SELECT d.status, a.kind FROM delivery_info d JOIN accounts a ON a.id=d.account_id WHERE d.account_id=?").get(accountId) as { status: string; kind: string } | undefined;
    if (!info) throw new HttpError(404, "no_encontrado");
    if (!NEXT[info.status]!.includes(b.status)) throw new HttpError(409, "transicion_invalida", `${info.status} → ${b.status}`);
    if (b.status === "en_camino" && info.kind !== "delivery") throw new HttpError(409, "transicion_invalida", "Solo el delivery sale en camino");
    if (b.status === "en_camino" && !b.driver) throw new HttpError(400, "validacion", "Indica el repartidor");
    if (b.status === "cancelado" && !b.reason) throw new HttpError(400, "motivo_requerido", "Indica el motivo de la cancelación");
    await db.prepare("UPDATE delivery_info SET status=?, driver=COALESCE(?,driver) WHERE account_id=?").run(b.status, b.driver ?? null, accountId);
    await audit(db, req.user.sub, `delivery_${b.status}`, "account", accountId, { driver: b.driver, reason: b.reason });
    hub.emit({ type: "delivery.updated", accountId, status: b.status });
    return { ok: true };
  });
}
