import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, newId } from "../db";
import { HttpError, refreshTable } from "../domain";

/** Clientes y reservaciones (Fase 2, sec. 26 y 27). */
export async function customerRoutes(app: FastifyInstance) {
  const { db, hub } = app;
  const id = z.object({ id: z.string() });

  const shape = {
    name: z.string().min(1),
    phone: z.string().nullable().optional(),
    email: z.string().email().nullable().optional(),
    rfc: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    uso_cfdi: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  };
  const body = z.object(shape);
  const cols = Object.keys(shape);

  app.get("/api/customers", { preHandler: app.authorize() }, async (req) => {
    const { q } = z.object({ q: z.string().optional() }).parse(req.query);
    return q
      ? db.prepare("SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? ORDER BY name LIMIT 50").all(`%${q}%`, `%${q}%`)
      : db.prepare("SELECT * FROM customers ORDER BY name LIMIT 200").all();
  });

  app.post("/api/customers", { preHandler: app.authorize("order.create") }, async (req, reply) => {
    const b = body.parse(req.body) as Record<string, string | null | undefined>;
    const cid = newId();
    db.prepare(`INSERT INTO customers (id,${cols.join(",")},created_at) VALUES (?,${cols.map(() => "?").join(",")},?)`).run(cid, ...cols.map((c) => b[c] ?? null), Date.now());
    audit(db, req.user.sub, "crear", "cliente", cid, { name: b.name });
    return reply.code(201).send({ id: cid });
  });

  app.patch("/api/customers/:id", { preHandler: app.authorize("order.create") }, async (req) => {
    const { id: cid } = id.parse(req.params);
    const b = body.partial().parse(req.body) as Record<string, string | null | undefined>;
    const keys = cols.filter((c) => b[c] !== undefined);
    if (keys.length === 0) throw new HttpError(400, "validacion", "Sin cambios");
    const r = db.prepare(`UPDATE customers SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`).run(...keys.map((k) => b[k] ?? null), cid);
    if (r.changes === 0) throw new HttpError(404, "no_encontrado");
    audit(db, req.user.sub, "editar", "cliente", cid);
    return { ok: true };
  });

  // Historial de consumo
  app.get("/api/customers/:id/history", { preHandler: app.authorize() }, async (req) => {
    const { id: cid } = id.parse(req.params);
    const customer = db.prepare("SELECT * FROM customers WHERE id=?").get(cid);
    if (!customer) throw new HttpError(404, "no_encontrado");
    const visits = db
      .prepare(
        `SELECT a.id, a.opened_at, a.kind, p.total_cents, p.tip_cents FROM accounts a JOIN payments p ON p.account_id=a.id
         WHERE a.customer_id=? ORDER BY a.opened_at DESC LIMIT 100`,
      )
      .all(cid) as { total_cents: number }[];
    const favorites = db
      .prepare(
        `SELECT i.name, SUM(i.quantity) units FROM order_items i JOIN accounts a ON a.id=i.account_id
         WHERE a.customer_id=? AND i.status='activo' GROUP BY i.product_id ORDER BY units DESC LIMIT 5`,
      )
      .all(cid);
    return { customer, visits, total_spent_cents: visits.reduce((s, v) => s + v.total_cents, 0), favorites };
  });

  app.post("/api/accounts/:id/customer", { preHandler: app.authorize("order.create") }, async (req) => {
    const { id: accountId } = id.parse(req.params);
    const { customerId } = z.object({ customerId: z.string().nullable() }).parse(req.body);
    const r = db.prepare("UPDATE accounts SET customer_id=? WHERE id=? AND status!='cerrada'").run(customerId, accountId);
    if (r.changes === 0) throw new HttpError(404, "no_encontrado");
    audit(db, req.user.sub, "asignar_cliente", "account", accountId, { customerId });
    return { ok: true };
  });

  // ---------- Reservaciones ----------
  const resBody = z.object({
    name: z.string().min(1),
    phone: z.string().optional(),
    party_size: z.number().int().min(1),
    at: z.number().int(),
    table_id: z.string().nullable().optional(),
    customer_id: z.string().nullable().optional(),
    notes: z.string().optional(),
  });

  app.get("/api/reservations", { preHandler: app.authorize() }, async (req) => {
    const q = z.object({ from: z.coerce.number().optional(), to: z.coerce.number().optional() }).parse(req.query);
    const from = q.from ?? new Date().setHours(0, 0, 0, 0);
    return db
      .prepare(`SELECT r.*, t.number AS table_number FROM reservations r LEFT JOIN tables_ t ON t.id=r.table_id WHERE r.at>=? AND r.at<? ORDER BY r.at`)
      .all(from, q.to ?? from + 7 * 86_400_000);
  });

  app.post("/api/reservations", { preHandler: app.authorize("reservation.manage") }, async (req, reply) => {
    const b = resBody.parse(req.body);
    if (b.table_id) {
      // Una mesa no admite dos reservaciones activas dentro de 90 minutos
      const clash = db
        .prepare("SELECT 1 FROM reservations WHERE table_id=? AND status IN ('pendiente','confirmada','llego') AND ABS(at-?)<?")
        .get(b.table_id, b.at, 90 * 60_000);
      if (clash) throw new HttpError(409, "mesa_reservada", "La mesa ya tiene una reservación en ese horario");
    }
    const rid = newId();
    db.prepare("INSERT INTO reservations (id,customer_id,name,phone,party_size,at,table_id,notes,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(
      rid, b.customer_id ?? null, b.name, b.phone ?? null, b.party_size, b.at, b.table_id ?? null, b.notes ?? null, req.user.sub, Date.now(),
    );
    audit(db, req.user.sub, "crear", "reservacion", rid, { name: b.name, at: b.at });
    hub.emit({ type: "reservation.updated", reservationId: rid });
    return reply.code(201).send({ id: rid });
  });

  const FLOW: Record<string, string[]> = {
    pendiente: ["confirmada", "cancelada", "no_se_presento", "llego"],
    confirmada: ["llego", "cancelada", "no_se_presento"],
    llego: [],
    cancelada: [],
    no_se_presento: [],
  };

  app.post("/api/reservations/:id/status", { preHandler: app.authorize("reservation.manage") }, async (req) => {
    const { id: rid } = id.parse(req.params);
    const { status } = z.object({ status: z.enum(["confirmada", "llego", "cancelada", "no_se_presento"]) }).parse(req.body);
    const r = db.prepare("SELECT status FROM reservations WHERE id=?").get(rid) as { status: string } | undefined;
    if (!r) throw new HttpError(404, "no_encontrado");
    if (!FLOW[r.status]!.includes(status)) throw new HttpError(409, "transicion_invalida", `${r.status} → ${status}`);
    db.prepare("UPDATE reservations SET status=? WHERE id=?").run(status, rid);
    audit(db, req.user.sub, `reservacion_${status}`, "reservacion", rid);
    hub.emit({ type: "reservation.updated", reservationId: rid });
    return { ok: true };
  });

  // Sentar: marca "llegó" y abre la cuenta en la mesa asignada (o en la indicada)
  app.post("/api/reservations/:id/seat", { preHandler: app.authorize("order.create") }, async (req, reply) => {
    const { id: rid } = id.parse(req.params);
    const { tableId } = z.object({ tableId: z.string().optional() }).parse(req.body ?? {});
    const r = db.prepare("SELECT * FROM reservations WHERE id=?").get(rid) as { status: string; table_id: string | null; party_size: number; customer_id: string | null } | undefined;
    if (!r) throw new HttpError(404, "no_encontrado");
    if (!["pendiente", "confirmada"].includes(r.status)) throw new HttpError(409, "transicion_invalida", r.status);
    const table = tableId ?? r.table_id;
    if (!table) throw new HttpError(400, "sin_mesa", "Indica la mesa donde se sienta");
    const accountId = newId();
    db.transaction(() => {
      const u = db.prepare("UPDATE tables_ SET status='ocupada', version=version+1 WHERE id=? AND status IN ('disponible','reservada')").run(table);
      if (u.changes === 0) throw new HttpError(409, "mesa_ocupada");
      db.prepare("INSERT INTO accounts (id,table_id,customer_id,waiter_id,opened_by,guests,opened_at) VALUES (?,?,?,?,?,?,?)").run(accountId, table, r.customer_id, req.user.sub, req.user.sub, r.party_size, Date.now());
      db.prepare("UPDATE reservations SET status='llego', table_id=? WHERE id=?").run(table, rid);
      refreshTable(db, table);
    })();
    audit(db, req.user.sub, "sentar_reservacion", "reservacion", rid, { accountId, table });
    hub.emit({ type: "table.updated", tableId: table });
    return reply.code(201).send({ accountId });
  });
}
