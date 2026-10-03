import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../db";
import { HttpError } from "../domain";
import { consumeForItems, emitAlerts } from "../inventory";
import { loadRouted, produce } from "../production";
import { syncDeliveryStatus } from "./operations";

/** Servicio en sala: tiempos retenidos (hold & fire), pantalla de pase, favoritos y cargo por servicio. */
export async function serviceRoutes(app: FastifyInstance) {
  const { db, hub } = app;
  const id = z.object({ id: z.string() });

  // ---------- Disparar un tiempo retenido ----------
  app.post("/api/accounts/:id/fire", { preHandler: app.authorize("order.create") }, async (req) => {
    const { id: accountId } = id.parse(req.params);
    const b = z.object({ course: z.string().optional(), itemIds: z.array(z.string()).optional() }).parse(req.body ?? {});
    const acc = await db
          .prepare("SELECT a.status, COALESCE(t.number, a.label) AS label, u.name AS waiter FROM accounts a LEFT JOIN tables_ t ON t.id=a.table_id JOIN users u ON u.id=a.waiter_id WHERE a.id=?")
          .get(accountId) as { status: string; label: string; waiter: string } | undefined;
    if (!acc) throw new HttpError(404, "no_encontrado");
    if (acc.status === "cerrada") throw new HttpError(409, "cuenta_cerrada");

    const held = await db.prepare("SELECT id, course FROM order_items WHERE account_id=? AND held=1 AND status='activo' ORDER BY rowid").all(accountId) as { id: string; course: string | null }[];
    const chosen = held.filter((i) => (b.itemIds ? b.itemIds.includes(i.id) : b.course ? i.course === b.course : true));
    if (chosen.length === 0) throw new HttpError(404, "nada_retenido", "No hay productos retenidos para mandar");

    let alerts: Awaited<ReturnType<typeof consumeForItems>> = [];
    const created = Date.now();
    const orders = new Set<string>();
    await db.transaction(async () => {
            const routed = await loadRouted(db, chosen.map((c) => c.id));
            // Una producción por comanda original: cada ticket queda ligado a la comanda de donde salió el producto
            for (const orderId of new Set(routed.map((r) => r.orderId))) {
              const items = routed.filter((r) => r.orderId === orderId).map((r) => r.item);
              const folio = (await db.prepare("SELECT folio FROM orders WHERE id=?").get(orderId) as { folio: number }).folio;
              alerts = alerts.concat(await consumeForItems(db, items, req.user.sub));
              const courses = [...new Set(items.map((i) => i.course).filter(Boolean))];
              await produce(db, { orderId, routed: items, kind: "tiempo", headline: `SALE: ${courses.join(" / ") || "TIEMPO"}`, tableLabel: acc.label, waiter: acc.waiter, folio, createdAt: created });
              orders.add(orderId);
            }
            await db.prepare(`UPDATE order_items SET held=0 WHERE id IN (${chosen.map(() => "?").join(",")})`).run(...chosen.map((c) => c.id));
          })();
    for (const orderId of orders) await syncDeliveryStatus(db, orderId, hub);
    await audit(db, req.user.sub, "disparar_tiempo", "account", accountId, { course: b.course, items: chosen.length });
    emitAlerts(hub, alerts);
    hub.emit({ type: "order.created", accountId, isAddition: true });
    return { ok: true, fired: chosen.length };
  });

  // ---------- Pantalla de pase (expo): todo lo que está en producción, agrupado por mesa ----------
  app.get("/api/pass", { preHandler: app.authorize() }, async () => {
    const rows = await db
          .prepare(
            `SELECT pt.id, pt.status, pt.created_at, pt.ready_at, a.id AS account_id, COALESCE(t.number, a.label) AS label, a.opened_at,
                u.name AS waiter, ar.name || ' / ' || sa.name AS station
         FROM production_tickets pt JOIN orders o ON o.id=pt.order_id JOIN accounts a ON a.id=o.account_id
         LEFT JOIN tables_ t ON t.id=a.table_id JOIN users u ON u.id=a.waiter_id
         JOIN stations s ON s.id=pt.station_id JOIN subareas sa ON sa.id=s.subarea_id JOIN areas ar ON ar.id=sa.area_id
         WHERE pt.status IN ('pendiente','recibido','preparando','listo') AND a.status!='cerrada' ORDER BY pt.created_at`,
          )
          .all() as { id: string; status: string; created_at: number; ready_at: number | null; account_id: string; label: string; opened_at: number; waiter: string; station: string }[];

    const lines = await db
          .prepare(
            `SELECT l.ticket_id, i.name, i.quantity, i.course FROM ticket_lines l JOIN order_items i ON i.id=l.item_id
         WHERE i.status='activo' AND l.ticket_id IN (SELECT id FROM production_tickets WHERE status IN ('pendiente','recibido','preparando','listo')) ORDER BY i.rowid`,
          )
          .all() as { ticket_id: string; name: string; quantity: number; course: string | null }[];

    const heldRows = await db.prepare("SELECT account_id, course, SUM(quantity) n FROM order_items WHERE held=1 AND status='activo' GROUP BY account_id, course").all() as { account_id: string; course: string; n: number }[];

    const byAccount = new Map<string, { account_id: string; label: string; waiter: string; oldest: number; tickets: unknown[]; ready: boolean; held: { course: string; n: number }[] }>();
    for (const r of rows) {
      const g = byAccount.get(r.account_id) ?? { account_id: r.account_id, label: r.label, waiter: r.waiter, oldest: r.created_at, tickets: [], ready: true, held: heldRows.filter((h) => h.account_id === r.account_id).map((h) => ({ course: h.course, n: h.n })) };
      g.oldest = Math.min(g.oldest, r.created_at);
      g.ready = g.ready && r.status === "listo";
      g.tickets.push({ id: r.id, status: r.status, station: r.station, created_at: r.created_at, ready_at: r.ready_at, lines: lines.filter((l) => l.ticket_id === r.id) });
      byAccount.set(r.account_id, g);
    }
    return [...byAccount.values()].sort((a, b) => Number(b.ready) - Number(a.ready) || a.oldest - b.oldest);
  });

  // Recuperar: devolver un ticket a la cocina (se marcó por error o hay que rehacerlo)
  app.post("/api/tickets/:id/recall", { preHandler: app.authorize("station.update") }, async (req) => {
    const { id: ticketId } = id.parse(req.params);
    const t = await db.prepare("SELECT status FROM production_tickets WHERE id=?").get(ticketId) as { status: string } | undefined;
    if (!t) throw new HttpError(404, "no_encontrado");
    const back: Record<string, { to: string; clear: string }> = {
      entregado: { to: "listo", clear: "delivered_at" },
      listo: { to: "preparando", clear: "ready_at" },
    };
    const step = back[t.status];
    if (!step) throw new HttpError(409, "transicion_invalida", `No se puede recuperar un ticket ${t.status}`);
    await db.prepare(`UPDATE production_tickets SET status=?, ${step.clear}=NULL WHERE id=?`).run(step.to, ticketId);
    await audit(db, req.user.sub, "recuperar_ticket", "ticket", ticketId, { from: t.status, to: step.to });
    hub.emit({ type: "ticket.updated", ticketId, status: step.to });
    return { ok: true, status: step.to };
  });

  // ---------- Favoritos del mesero ----------
  app.get("/api/favorites", { preHandler: app.authorize() }, async (req) =>
    db
      .prepare("SELECT f.product_id, f.uses, f.pinned FROM user_favorites f JOIN products p ON p.id=f.product_id WHERE f.user_id=? AND p.active=1 ORDER BY f.pinned DESC, f.uses DESC LIMIT 30")
      .all(req.user.sub),
  );

  app.post("/api/favorites/:id/pin", { preHandler: app.authorize() }, async (req) => {
    const { id: productId } = id.parse(req.params);
    const { pinned } = z.object({ pinned: z.boolean() }).parse(req.body);
    if (!await db.prepare("SELECT 1 FROM products WHERE id=?").get(productId)) throw new HttpError(404, "no_encontrado");
    await db.prepare("INSERT INTO user_favorites (user_id,product_id,uses,pinned) VALUES (?,?,0,?) ON CONFLICT(user_id,product_id) DO UPDATE SET pinned=excluded.pinned").run(req.user.sub, productId, pinned ? 1 : 0);
    return { ok: true };
  });

  // ---------- Comensales de la cuenta (sec. 25): cambian el cargo por servicio y el promedio por persona ----------
  app.post("/api/accounts/:id/guests", { preHandler: app.authorize("order.create") }, async (req) => {
    const { id: accountId } = id.parse(req.params);
    const { guests } = z.object({ guests: z.number().int().min(1).max(99) }).parse(req.body);
    const r = await db.prepare("UPDATE accounts SET guests=? WHERE id=? AND status!='cerrada'").run(guests, accountId);
    if (r.changes === 0) throw new HttpError(404, "no_encontrado");
    await audit(db, req.user.sub, "comensales", "account", accountId, { guests });
    hub.emit({ type: "order.updated", accountId });
    hub.emit({ type: "table.updated" });
    return { ok: true };
  });

  // ---------- Cargo por servicio: dispensar en una cuenta ----------
  app.post("/api/accounts/:id/service-charge", { preHandler: app.authorize("discount.apply") }, async (req) => {
    const { id: accountId } = id.parse(req.params);
    const { waive } = z.object({ waive: z.boolean() }).parse(req.body);
    const r = await db.prepare("UPDATE accounts SET service_waived=? WHERE id=? AND status!='cerrada'").run(waive ? 1 : 0, accountId);
    if (r.changes === 0) throw new HttpError(404, "no_encontrado");
    await audit(db, req.user.sub, waive ? "dispensar_servicio" : "aplicar_servicio", "account", accountId);
    hub.emit({ type: "order.updated", accountId });
    return { ok: true };
  });
}
