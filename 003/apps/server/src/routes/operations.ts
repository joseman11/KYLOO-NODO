import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { OrderItem } from "@003/shared";
import { audit, newId, type Db } from "../db";
import {
  HttpError,
  accountBalance,
  accountDiscounts,
  accountPaid,
  accountSubtotal,
  accountTotal,
  authorize,
  deliveryFee,
  refreshTable,
  serviceChargeCents,
} from "../domain";
import { consumeForItems, emitAlerts, restoreForItem } from "../inventory";
import { enqueue } from "../printing/queue";
import { produce, routesFor } from "../production";
import { renderBill } from "../printing/render";
import { ticketStyle } from "../ticket-style";
import { BIG } from "../printing/markup";
import type { Hub } from "../hub";

interface RouteRow {
  station_id: string;
  area: string;
  subarea: string;
  p1: string | null;
  p2: string | null;
}

const orderBody = z.object({
  clientId: z.string().min(8).optional(),
  items: z
    .array(
      z.object({
        productId: z.string(),
        quantity: z.number().int().min(1).max(99).default(1),
        modifierIds: z.array(z.string()).default([]),
        note: z.string().max(200).optional(),
        /** Tiempo / separador de la comanda (Entradas, Plato fuerte…). */
        course: z.string().trim().min(1).max(40).optional(),
        /** Asiento de la mesa (1…20). */
        seat: z.number().int().min(1).max(20).optional(),
        /** Retener este tiempo: se manda a producir cuando el mesero lo dispare. */
        hold: z.boolean().optional(),
      }),
    )
    .min(1),
});

export async function operationsRoutes(app: FastifyInstance, opts: { hub: Hub }) {
  const { db } = app;
  const { hub } = opts;
  const id = z.object({ id: z.string() });

  const _printerOf = async (printerId: string) =>
    (await db.prepare("SELECT paper_width FROM printers WHERE id=?").get(printerId)) as
      | { paper_width: number }
      | undefined;

  // ---------- Mapa de mesas ----------
  app.get("/api/floor", { preHandler: app.authorize() }, async () => {
    const tables = (await db
      .prepare("SELECT * FROM tables_ ORDER BY LENGTH(number), number")
      .all()) as { id: string }[];
    const accounts = (await db
      .prepare(
        `SELECT a.id, a.table_id, a.status, a.opened_at, a.guests, a.waiter_id, u.name AS waiter,
                (SELECT MAX(o.created_at) FROM orders o WHERE o.account_id=a.id) AS last_order_at
         FROM accounts a JOIN users u ON u.id=a.waiter_id WHERE a.status!='cerrada'`,
      )
      .all()) as { id: string; table_id: string }[];
    const links = (await db.prepare("SELECT table_id, account_id FROM table_links").all()) as {
      table_id: string;
      account_id: string;
    }[];
    const numberOf = new Map(
      (tables as { id: string; number: string }[]).map((t) => [t.id, t.number]),
    );
    return Promise.all(
      tables.map(async (t) => {
        const link = links.find((l) => l.table_id === t.id);
        const main = link ? accounts.find((a) => a.id === link.account_id) : undefined;
        const own = accounts.filter((a) => a.table_id === t.id);
        const joined = links
          .filter((l) => own.some((a) => a.id === l.account_id))
          .map((l) => numberOf.get(l.table_id)!);
        return {
          ...t,
          linked_to: main ? (numberOf.get(main.table_id) ?? null) : null,
          joined,
          accounts: await Promise.all(
            (main ? [main] : own).map(async (a) => ({
              ...a,
              total_cents: await accountTotal(db, a.id),
              paid_cents: await accountPaid(db, a.id),
            })),
          ),
        };
      }),
    );
  });

  // ---------- Abrir mesa (HU-001, RN-001, concurrencia sec. 68) ----------
  app.post(
    "/api/tables/:id/open",
    { preHandler: app.authorize("order.create") },
    async (req, reply) => {
      const { id: tableId } = id.parse(req.params);
      const { guests, clientId } = z
        .object({
          guests: z.number().int().min(1).default(1),
          clientId: z.string().min(8).optional(),
        })
        .parse(req.body ?? {});
      // Idempotente: un reintento (p. ej. tras volver la red) devuelve la misma cuenta en vez de chocar con la mesa ocupada
      if (clientId) {
        const dup = (await db.prepare("SELECT id FROM accounts WHERE client_id=?").get(clientId)) as
          | { id: string }
          | undefined;
        if (dup) return reply.code(200).send({ id: dup.id, duplicate: true });
      }
      const accountId = newId();
      await db.transaction(async () => {
        const r = await db
          .prepare(
            "UPDATE tables_ SET status='ocupada', version=version+1 WHERE id=? AND status IN ('disponible','reservada')",
          )
          .run(tableId);
        if (r.changes === 0) {
          const t = (await db.prepare("SELECT status FROM tables_ WHERE id=?").get(tableId)) as
            | { status: string }
            | undefined;
          throw t
            ? new HttpError(409, "mesa_ocupada", `La mesa está ${t.status}`)
            : new HttpError(404, "no_encontrado");
        }
        await db
          .prepare(
            "INSERT INTO accounts (id,table_id,waiter_id,opened_by,guests,opened_at,client_id) VALUES (?,?,?,?,?,?,?)",
          )
          .run(
            accountId,
            tableId,
            req.user.sub,
            req.user.sub,
            guests,
            Date.now(),
            clientId ?? null,
          );
      })();
      await audit(db, req.user.sub, "abrir_mesa", "account", accountId, { tableId, guests });
      hub.emit({ type: "table.updated", tableId });
      return reply.code(201).send({ id: accountId });
    },
  );

  // ---------- Cuenta ----------
  app.get("/api/accounts/:id", { preHandler: app.authorize() }, async (req) => {
    const { id: accountId } = id.parse(req.params);
    const account = await db
      .prepare(
        `SELECT a.*, COALESCE(t.number, a.label) AS table_number, u.name AS waiter FROM accounts a
         LEFT JOIN tables_ t ON t.id=a.table_id JOIN users u ON u.id=a.waiter_id WHERE a.id=?`,
      )
      .get(accountId);
    if (!account) throw new HttpError(404, "no_encontrado");
    const items = (
      (await db
        .prepare("SELECT * FROM order_items WHERE account_id=? ORDER BY rowid")
        .all(accountId)) as { modifiers: string }[]
    ).map((i) => ({ ...i, modifiers: JSON.parse(i.modifiers) }));
    const discounts = await db
      .prepare(
        "SELECT id, kind, value, amount_cents, reason, promotion_id FROM account_discounts WHERE account_id=? ORDER BY created_at",
      )
      .all(accountId);
    return {
      ...account,
      items,
      discounts,
      subtotal_cents: await accountSubtotal(db, accountId),
      discount_cents: await accountDiscounts(db, accountId),
      delivery_fee_cents: await deliveryFee(db, accountId),
      service_charge_cents: await serviceChargeCents(db, accountId),
      total_cents: await accountTotal(db, accountId),
      paid_cents: await accountPaid(db, accountId),
      balance_cents: await accountBalance(db, accountId),
    };
  });

  // ---------- Enviar comanda / adición (HU-002, HU-003, HU-005) ----------
  app.post(
    "/api/accounts/:id/orders",
    { preHandler: app.authorize("order.create") },
    async (req, reply) => {
      const { id: accountId } = id.parse(req.params);
      const body = orderBody.parse(req.body);

      if (body.clientId) {
        const dup = (await db
          .prepare("SELECT id FROM orders WHERE client_id=?")
          .get(body.clientId)) as { id: string } | undefined;
        if (dup) return reply.code(200).send({ id: dup.id, duplicate: true });
      }

      const account = (await db
        .prepare(
          "SELECT a.*, COALESCE(t.number, a.label) AS table_number, u.name AS waiter FROM accounts a LEFT JOIN tables_ t ON t.id=a.table_id JOIN users u ON u.id=a.waiter_id WHERE a.id=?",
        )
        .get(accountId)) as
        | { id: string; status: string; table_number: string; waiter: string }
        | undefined;
      if (!account) throw new HttpError(404, "no_encontrado");
      if (account.status === "cerrada")
        throw new HttpError(
          409,
          "cuenta_cerrada",
          "Una cuenta cerrada no puede modificarse (RN-009)",
        );

      const orderId = newId();
      const created = Date.now();
      let folio = 0;
      let isAddition = false;
      let stockAlerts: Awaited<ReturnType<typeof consumeForItems>> = [];

      await db.transaction(async () => {
        folio =
          ((await db.prepare("SELECT COALESCE(MAX(folio),0) m FROM orders").get()) as { m: number })
            .m + 1;
        isAddition = !!(await db
          .prepare("SELECT 1 FROM orders WHERE account_id=? AND status!='cancelada'")
          .get(accountId));
        await db
          .prepare(
            "INSERT INTO orders (id,folio,account_id,is_addition,created_by,client_id,created_at) VALUES (?,?,?,?,?,?,?)",
          )
          .run(
            orderId,
            folio,
            accountId,
            isAddition ? 1 : 0,
            req.user.sub,
            body.clientId ?? null,
            created,
          );

        const routed: OrderItem[] = [];
        for (const it of body.items) {
          const p = (await db
            .prepare("SELECT * FROM products WHERE id=? AND active=1")
            .get(it.productId)) as
            | { id: string; name: string; price_cents: number; availability: string }
            | undefined;
          if (!p) throw new HttpError(404, "producto_no_encontrado");
          if (p.availability !== "disponible")
            throw new HttpError(409, "producto_agotado", `${p.name} no está disponible`);

          // Modificadores: pertenecen al producto, grupos obligatorios y límites
          const groups = (await db
            .prepare(
              "SELECT g.* FROM modifier_groups g JOIN product_modifier_groups pg ON pg.group_id=g.id WHERE pg.product_id=?",
            )
            .all(p.id)) as {
            id: string;
            name: string;
            required: number;
            multiple: number;
            max_select: number | null;
          }[];
          const mods: { id: string; group_id: string; name: string; price_cents: number }[] = [];
          for (const mid of it.modifierIds) {
            const m = (await db.prepare("SELECT * FROM modifiers WHERE id=?").get(mid)) as
              | { id: string; group_id: string; name: string; price_cents: number }
              | undefined;
            if (!m || !groups.some((g) => g.id === m.group_id))
              throw new HttpError(400, "modificador_invalido");
            mods.push(m);
          }
          for (const g of groups) {
            const n = mods.filter((m) => m.group_id === g.id).length;
            if (g.required && n === 0)
              throw new HttpError(
                400,
                "modificador_requerido",
                `${p.name}: falta elegir ${g.name}`,
              );
            if (!g.multiple && n > 1)
              throw new HttpError(400, "modificador_invalido", `${g.name}: solo una opción`);
            if (g.max_select && n > g.max_select)
              throw new HttpError(400, "modificador_invalido", `${g.name}: máximo ${g.max_select}`);
          }

          const unit = p.price_cents + mods.reduce((s, m) => s + m.price_cents, 0);
          const itemId = newId();
          const modNames = mods.map((m) => m.name);
          const held = it.hold && it.course ? 1 : 0; // solo un tiempo con nombre puede retenerse
          await db
            .prepare(
              "INSERT INTO order_items (id,order_id,account_id,product_id,name,quantity,unit_price_cents,modifiers,note,course,seat,held) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              itemId,
              orderId,
              accountId,
              p.id,
              p.name,
              it.quantity,
              unit,
              JSON.stringify(modNames),
              it.note ?? null,
              it.course ?? null,
              it.seat ?? null,
              held,
            );

          // Favoritos del mesero: los más pedidos quedan a la mano
          await db
            .prepare(
              "INSERT INTO user_favorites (user_id,product_id,uses) VALUES (?,?,?) ON CONFLICT(user_id,product_id) DO UPDATE SET uses=user_favorites.uses+excluded.uses",
            )
            .run(req.user.sub, p.id, it.quantity);

          // Lo retenido no se produce ni descuenta inventario hasta que se dispare ese tiempo
          if (held) continue;
          routed.push({
            id: itemId,
            productId: p.id,
            name: p.name,
            quantity: it.quantity,
            modifiers: modNames,
            ...(it.note ? { note: it.note } : {}),
            ...(it.course ? { course: it.course } : {}),
            ...(it.seat ? { seat: it.seat } : {}),
            routes: await routesFor(db, p.id),
          });
        }

        stockAlerts = await consumeForItems(db, routed, req.user.sub);
        // Motor de enrutamiento: un ticket de producción por estación (sec. 12)
        await produce(db, {
          orderId,
          routed,
          kind: isAddition ? "adicion" : "comanda",
          tableLabel: account.table_number,
          waiter: account.waiter,
          folio,
          createdAt: created,
        });
      })();

      await audit(
        db,
        req.user.sub,
        isAddition ? "enviar_adicion" : "enviar_comanda",
        "order",
        orderId,
        { accountId, folio, items: body.items.length },
      );
      emitAlerts(hub, stockAlerts);
      hub.emit({ type: "order.created", orderId, accountId, isAddition });
      return reply.code(201).send({ id: orderId, folio, isAddition });
    },
  );

  // Listos para entregar (pase): tickets terminados por producción aún sin entregar
  app.get("/api/ready", { preHandler: app.authorize() }, async () =>
    db
      .prepare(
        `SELECT pt.id, pt.ready_at, COALESCE(t.number, a.label) AS table_number, u.name AS waiter, a.waiter_id,
                ar.name || ' / ' || sa.name AS station
         FROM production_tickets pt JOIN orders o ON o.id=pt.order_id JOIN accounts a ON a.id=o.account_id
         LEFT JOIN tables_ t ON t.id=a.table_id JOIN users u ON u.id=a.waiter_id
         JOIN stations s ON s.id=pt.station_id JOIN subareas sa ON sa.id=s.subarea_id JOIN areas ar ON ar.id=sa.area_id
         WHERE pt.status='listo' ORDER BY pt.ready_at`,
      )
      .all(),
  );

  // ---------- Tickets de producción / KDS ----------
  app.get("/api/stations/:id/queue", { preHandler: app.authorize() }, async (req) => {
    const { id: stationId } = id.parse(req.params);
    const tickets = (await db
      .prepare(
        `SELECT pt.*, o.folio, o.is_addition, COALESCE(t.number, a.label) AS table_number, u.name AS waiter
         FROM production_tickets pt JOIN orders o ON o.id=pt.order_id JOIN accounts a ON a.id=o.account_id
         LEFT JOIN tables_ t ON t.id=a.table_id JOIN users u ON u.id=a.waiter_id
         WHERE pt.station_id=? AND pt.status IN ('pendiente','recibido','preparando','listo') ORDER BY pt.created_at`,
      )
      .all(stationId)) as { id: string }[];
    return Promise.all(
      tickets.map(async (t) => ({
        ...t,
        lines: (
          (await db
            .prepare(
              "SELECT i.id, i.name, i.quantity, i.modifiers, i.note, i.course, i.status FROM ticket_lines l JOIN order_items i ON i.id=l.item_id WHERE l.ticket_id=? ORDER BY i.rowid",
            )
            .all(t.id)) as { modifiers: string }[]
        ).map((l) => ({ ...l, modifiers: JSON.parse(l.modifiers) })),
      })),
    );
  });

  const NEXT: Record<
    string,
    {
      from: string[];
      col: string;
      perm: "station.update" | "item.mark_ready" | "item.mark_delivered";
    }
  > = {
    recibido: { from: ["pendiente"], col: "received_at", perm: "station.update" },
    preparando: { from: ["pendiente", "recibido"], col: "started_at", perm: "station.update" },
    listo: { from: ["recibido", "preparando"], col: "ready_at", perm: "item.mark_ready" },
    entregado: { from: ["listo"], col: "delivered_at", perm: "item.mark_delivered" },
  };

  app.post("/api/tickets/:id/status", { preHandler: app.authorize() }, async (req) => {
    const { id: ticketId } = id.parse(req.params);
    const { status } = z
      .object({ status: z.enum(["recibido", "preparando", "listo", "entregado"]) })
      .parse(req.body);
    const rule = NEXT[status]!;
    if (!req.user.permissions.includes(rule.perm))
      throw new HttpError(403, "sin_permiso", rule.perm);
    const t = (await db.prepare("SELECT * FROM production_tickets WHERE id=?").get(ticketId)) as
      | { id: string; order_id: string; status: string }
      | undefined;
    if (!t) throw new HttpError(404, "no_encontrado");
    if (!rule.from.includes(t.status))
      throw new HttpError(409, "transicion_invalida", `${t.status} → ${status}`);
    await db
      .prepare(`UPDATE production_tickets SET status=?, ${rule.col}=? WHERE id=?`)
      .run(status, Date.now(), ticketId);

    // Estado de la comanda derivado de sus tickets (sec. 7 / 69)
    const all = (
      (await db
        .prepare("SELECT status FROM production_tickets WHERE order_id=? AND status!='cancelado'")
        .all(t.order_id)) as { status: string }[]
    ).map((r) => r.status);
    const orderStatus = all.every((s) => s === "entregado")
      ? "entregada"
      : all.every((s) => s === "listo" || s === "entregado")
        ? "preparada"
        : all.some((s) => s !== "pendiente")
          ? "en_preparacion"
          : "enviada";
    await db.prepare("UPDATE orders SET status=? WHERE id=?").run(orderStatus, t.order_id);

    await syncDeliveryStatus(db, t.order_id, hub);
    await audit(db, req.user.sub, `ticket_${status}`, "ticket", ticketId);
    hub.emit({ type: "ticket.updated", ticketId, status, orderId: t.order_id });
    return { ok: true, orderStatus };
  });

  // ---------- Cancelar producto (HU-006, sec. 16, RN-005) ----------
  app.post("/api/items/:id/cancel", { preHandler: app.authorize("item.cancel") }, async (req) => {
    const { id: itemId } = id.parse(req.params);
    const b = z
      .object({
        reason: z.string().min(2),
        authorizerId: z.string().optional(),
        authorizerPin: z.string().optional(),
      })
      .parse(req.body);
    const item = (await db.prepare("SELECT * FROM order_items WHERE id=?").get(itemId)) as
      | { id: string; account_id: string; name: string; quantity: number; status: string }
      | undefined;
    if (!item) throw new HttpError(404, "no_encontrado");
    if (item.status === "cancelado") throw new HttpError(409, "ya_cancelado");

    const tickets = (await db
      .prepare(
        "SELECT pt.id, pt.status, pt.station_id FROM ticket_lines l JOIN production_tickets pt ON pt.id=l.ticket_id WHERE l.item_id=?",
      )
      .all(itemId)) as { id: string; status: string; station_id: string }[];
    const afterProduction = tickets.some((t) => t.status !== "pendiente");
    let authorizedBy: string | null = null;
    if (afterProduction)
      authorizedBy = await authorize(db, b.authorizerId, b.authorizerPin, "order.cancel");

    await db.transaction(async () => {
      await db
        .prepare(
          "UPDATE order_items SET status='cancelado', cancel_reason=?, cancelled_by=?, authorized_by=?, cancelled_after_production=? WHERE id=?",
        )
        .run(b.reason, req.user.sub, authorizedBy, afterProduction ? 1 : 0, itemId);
      for (const t of tickets) {
        const left = (await db
          .prepare(
            "SELECT COUNT(*) c FROM ticket_lines l JOIN order_items i ON i.id=l.item_id WHERE l.ticket_id=? AND i.status='activo'",
          )
          .get(t.id)) as { c: number };
        if (left.c === 0 && t.status === "pendiente")
          await db.prepare("UPDATE production_tickets SET status='cancelado' WHERE id=?").run(t.id);
        // Aviso a la estación para que no prepare el producto
        const st = (await db
          .prepare("SELECT primary_printer_id p, secondary_printer_id s FROM stations WHERE id=?")
          .get(t.station_id)) as { p: string | null; s: string | null };
        if (st.p)
          await enqueue(db, {
            kind: "cancelacion",
            ticketId: t.id,
            printerId: st.p,
            fallbackPrinterId: st.s,
            lines: [`${BIG}CANCELADO`, `${item.quantity} x ${item.name}`, `Motivo: ${b.reason}`],
          });
      }
    })();
    if (!afterProduction) await restoreForItem(db, itemId, req.user.sub, b.reason);
    await audit(db, req.user.sub, "cancelar_producto", "item", itemId, {
      reason: b.reason,
      afterProduction,
      authorizedBy,
    });
    hub.emit({ type: "order.updated", accountId: item.account_id });
    return { ok: true, afterProduction };
  });

  // ---------- Operaciones de mesa/cuenta ----------
  const accountOr404 = async (accountId: string) => {
    const a = (await db.prepare("SELECT * FROM accounts WHERE id=?").get(accountId)) as
      | { id: string; table_id: string | null; status: string; waiter_id: string }
      | undefined;
    if (!a) throw new HttpError(404, "no_encontrado");
    if (a.status === "cerrada")
      throw new HttpError(
        409,
        "cuenta_cerrada",
        "Una cuenta cerrada no puede modificarse (RN-009)",
      );
    return a;
  };

  app.post(
    "/api/accounts/:id/transfer",
    { preHandler: app.authorize("table.transfer") },
    async (req) => {
      const { id: accountId } = id.parse(req.params);
      const { waiterId } = z.object({ waiterId: z.string() }).parse(req.body);
      const a = await accountOr404(accountId);
      if (!(await db.prepare("SELECT 1 FROM users WHERE id=? AND active=1").get(waiterId)))
        throw new HttpError(404, "usuario_no_encontrado");
      await db.prepare("UPDATE accounts SET waiter_id=? WHERE id=?").run(waiterId, accountId);
      await audit(db, req.user.sub, "transferir_mesa", "account", accountId, {
        from: a.waiter_id,
        to: waiterId,
      });
      hub.emit({ type: "table.updated", tableId: a.table_id });
      return { ok: true };
    },
  );

  app.post("/api/accounts/:id/move", { preHandler: app.authorize("table.change") }, async (req) => {
    const { id: accountId } = id.parse(req.params);
    const { tableId, reason } = z
      .object({ tableId: z.string(), reason: z.string().optional() })
      .parse(req.body);
    const a = await accountOr404(accountId);
    if (!a.table_id)
      throw new HttpError(
        400,
        "cuenta_sin_mesa",
        "Las cuentas para llevar/delivery no tienen mesa",
      );
    await db.transaction(async () => {
      const r = await db
        .prepare(
          "UPDATE tables_ SET status='ocupada', version=version+1 WHERE id=? AND status='disponible'",
        )
        .run(tableId);
      if (r.changes === 0)
        throw new HttpError(409, "mesa_ocupada", "La mesa destino no está disponible");
      await db.prepare("UPDATE accounts SET table_id=? WHERE id=?").run(tableId, accountId);
      await refreshTable(db, a.table_id);
      await refreshTable(db, tableId);
    })();
    await audit(db, req.user.sub, "cambiar_mesa", "account", accountId, {
      from: a.table_id,
      to: tableId,
      reason,
    });
    hub.emit({ type: "table.updated", tableId: a.table_id });
    hub.emit({ type: "table.updated", tableId });
    return { ok: true };
  });

  app.post("/api/accounts/:id/merge", { preHandler: app.authorize("bill.merge") }, async (req) => {
    const { id: targetId } = id.parse(req.params);
    const { sourceAccountId } = z.object({ sourceAccountId: z.string() }).parse(req.body);
    if (sourceAccountId === targetId) throw new HttpError(400, "validacion");
    const target = await accountOr404(targetId);
    const source = await accountOr404(sourceAccountId);
    await db.transaction(async () => {
      await db
        .prepare("UPDATE order_items SET account_id=? WHERE account_id=?")
        .run(targetId, sourceAccountId);
      await db
        .prepare("UPDATE orders SET account_id=? WHERE account_id=?")
        .run(targetId, sourceAccountId);
      await db
        .prepare("UPDATE accounts SET status='cerrada', closed_at=? WHERE id=?")
        .run(Date.now(), sourceAccountId);
      // La mesa de la cuenta absorbida queda unida a la cuenta destino (mesa 1 + mesa 2)
      await db
        .prepare("UPDATE table_links SET account_id=? WHERE account_id=?")
        .run(targetId, sourceAccountId);
      if (source.table_id && source.table_id !== target.table_id) {
        await db
          .prepare(
            "INSERT INTO table_links (table_id, account_id, created_at) VALUES (?,?,?) ON CONFLICT(table_id) DO UPDATE SET account_id=excluded.account_id, created_at=excluded.created_at",
          )
          .run(source.table_id, targetId, Date.now());
      }
      const g = (await db
        .prepare("SELECT guests FROM accounts WHERE id=?")
        .get(sourceAccountId)) as { guests: number };
      await db.prepare("UPDATE accounts SET guests=guests+? WHERE id=?").run(g.guests, targetId);
      await refreshTable(db, source.table_id);
      await refreshTable(db, target.table_id);
    })();
    await audit(db, req.user.sub, "fusionar_cuentas", "account", targetId, {
      source: sourceAccountId,
    });
    hub.emit({ type: "table.updated", tableId: source.table_id });
    hub.emit({ type: "table.updated", tableId: target.table_id });
    return { ok: true };
  });

  // Unir una mesa libre a la cuenta (juntar mesa 1 con la 2). Si la otra mesa ya tiene cuenta, se fusionan desde "Fusionar".
  app.post("/api/accounts/:id/join", { preHandler: app.authorize("bill.merge") }, async (req) => {
    const { id: accountId } = id.parse(req.params);
    const { tableId } = z.object({ tableId: z.string() }).parse(req.body);
    const a = await accountOr404(accountId);
    if (!a.table_id)
      throw new HttpError(
        400,
        "cuenta_sin_mesa",
        "Las cuentas para llevar/delivery no tienen mesa",
      );
    if (tableId === a.table_id) throw new HttpError(400, "validacion");
    await db.transaction(async () => {
      const t = (await db.prepare("SELECT status FROM tables_ WHERE id=?").get(tableId)) as
        | { status: string }
        | undefined;
      if (!t) throw new HttpError(404, "no_encontrado");
      if (!["disponible", "reservada"].includes(t.status))
        throw new HttpError(409, "mesa_ocupada", "La mesa que quieres unir no está libre");
      await db
        .prepare("INSERT INTO table_links (table_id, account_id, created_at) VALUES (?,?,?)")
        .run(tableId, accountId, Date.now());
      await refreshTable(db, tableId);
    })();
    await audit(db, req.user.sub, "unir_mesas", "account", accountId, {
      tableId,
      main: a.table_id,
    });
    hub.emit({ type: "table.updated", tableId });
    hub.emit({ type: "table.updated", tableId: a.table_id });
    return { ok: true };
  });

  app.post("/api/tables/:id/unjoin", { preHandler: app.authorize("bill.merge") }, async (req) => {
    const { id: tableId } = id.parse(req.params);
    const link = (await db
      .prepare("SELECT account_id FROM table_links WHERE table_id=?")
      .get(tableId)) as { account_id: string } | undefined;
    if (!link) throw new HttpError(404, "no_encontrado", "Esa mesa no está unida");
    await db.prepare("DELETE FROM table_links WHERE table_id=?").run(tableId);
    await refreshTable(db, tableId);
    await audit(db, req.user.sub, "separar_mesa", "table", tableId, { account: link.account_id });
    hub.emit({ type: "table.updated", tableId });
    return { ok: true };
  });

  // División por producto: mueve los ítems indicados a una cuenta nueva (HU-009)
  app.post(
    "/api/accounts/:id/split",
    { preHandler: app.authorize("bill.split") },
    async (req, reply) => {
      const { id: accountId } = id.parse(req.params);
      const { itemIds } = z.object({ itemIds: z.array(z.string()).min(1) }).parse(req.body);
      const a = await accountOr404(accountId);
      const newAccount = newId();
      await db.transaction(async () => {
        await db
          .prepare(
            "INSERT INTO accounts (id,table_id,waiter_id,opened_by,guests,opened_at) VALUES (?,?,?,?,?,?)",
          )
          .run(newAccount, a.table_id, a.waiter_id, req.user.sub, 1, Date.now());
        for (const itemId of itemIds) {
          const r = await db
            .prepare(
              "UPDATE order_items SET account_id=? WHERE id=? AND account_id=? AND status='activo'",
            )
            .run(newAccount, itemId, accountId);
          if (r.changes === 0)
            throw new HttpError(400, "item_invalido", `Ítem ${itemId} no pertenece a la cuenta`);
        }
      })();
      await audit(db, req.user.sub, "dividir_cuenta", "account", accountId, {
        newAccount,
        itemIds,
      });
      hub.emit({ type: "table.updated", tableId: a.table_id });
      return reply.code(201).send({ id: newAccount });
    },
  );

  // ---------- Solicitar cuenta ----------
  app.post(
    "/api/accounts/:id/request-bill",
    { preHandler: app.authorize("order.create") },
    async (req) => {
      const { id: accountId } = id.parse(req.params);
      const a = await accountOr404(accountId);
      await db.prepare("UPDATE accounts SET status='pago_solicitado' WHERE id=?").run(accountId);
      await refreshTable(db, a.table_id);

      const printer = (await db
        .prepare(
          "SELECT id, paper_width FROM printers WHERE kind='caja' AND active=1 ORDER BY rowid LIMIT 1",
        )
        .get()) as { id: string; paper_width: number } | undefined;
      if (printer)
        await enqueue(db, {
          kind: "precuenta",
          printerId: printer.id,
          lines: await billLines(db, accountId, printer.paper_width),
        });
      await audit(db, req.user.sub, "solicitar_cuenta", "account", accountId);
      hub.emit({ type: "table.updated", tableId: a.table_id });
      return { ok: true, total_cents: await accountTotal(db, accountId) };
    },
  );
}

export async function billLines(
  db: Db,
  accountId: string,
  paper: number,
  extra: {
    tipCents?: number;
    payments?: { method: string; amountCents: number }[];
    changeCents?: number;
    partial?: { coveredCents: number; balanceCents: number };
  } = {},
): Promise<string[]> {
  const acc = (await db
    .prepare(
      "SELECT a.opened_at, COALESCE(t.number, a.label) tn, u.name waiter FROM accounts a LEFT JOIN tables_ t ON t.id=a.table_id JOIN users u ON u.id=a.waiter_id WHERE a.id=?",
    )
    .get(accountId)) as { opened_at: number; tn: string; waiter: string };
  // La categoría de la cuenta es la de más arriba del árbol (Tacos › De calamar → "Tacos")
  const items = (await db
    .prepare(
      `SELECT i.name, i.quantity, i.unit_price_cents, COALESCE(c3.name, c2.name, c1.name) AS category
       FROM order_items i JOIN products p ON p.id=i.product_id
       LEFT JOIN categories c1 ON c1.id=p.category_id LEFT JOIN categories c2 ON c2.id=c1.parent_id LEFT JOIN categories c3 ON c3.id=c2.parent_id
       WHERE i.account_id=? AND i.status='activo' ORDER BY i.rowid`,
    )
    .all(accountId)) as {
    name: string;
    quantity: number;
    unit_price_cents: number;
    category: string | null;
  }[];
  const est =
    (
      (await db.prepare("SELECT value FROM settings WHERE key='establishment_name'").get()) as
        | { value: string }
        | undefined
    )?.value ?? "Restaurante";
  return renderBill(
    {
      establishment: est,
      tableNumber: acc.tn,
      waiter: acc.waiter,
      createdAt: Date.now(),
      lines: items.map((i) => ({
        quantity: i.quantity,
        name: i.name,
        totalCents: i.quantity * i.unit_price_cents,
        category: i.category,
      })),
      totalCents: await accountTotal(db, accountId),
      discountCents: await accountDiscounts(db, accountId),
      deliveryFeeCents: await deliveryFee(db, accountId),
      serviceChargeCents: await serviceChargeCents(db, accountId),
      serviceChargeLabel: await serviceChargeLabel(db),
      ...extra,
    },
    paper,
    await ticketStyle(db),
  );
}

/** Si la cuenta es para llevar/delivery, su estado sigue a la producción: recibido → preparando → listo. */
export async function syncDeliveryStatus(db: Db, orderId: string, hub: Hub): Promise<void> {
  const acc = (await db.prepare("SELECT account_id id FROM orders WHERE id=?").get(orderId)) as
    | { id: string }
    | undefined;
  if (!acc) return;
  const info = (await db
    .prepare("SELECT status FROM delivery_info WHERE account_id=?")
    .get(acc.id)) as { status: string } | undefined;
  if (!info || !["recibido", "preparando", "listo"].includes(info.status)) return;
  const tickets = (
    (await db
      .prepare(
        "SELECT pt.status FROM production_tickets pt JOIN orders o ON o.id=pt.order_id WHERE o.account_id=? AND pt.status!='cancelado'",
      )
      .all(acc.id)) as { status: string }[]
  ).map((r) => r.status);
  if (tickets.length === 0) return;
  const next = tickets.every((s) => s === "listo" || s === "entregado")
    ? "listo"
    : tickets.some((s) => s !== "pendiente")
      ? "preparando"
      : "recibido";
  if (next !== info.status) {
    await db.prepare("UPDATE delivery_info SET status=? WHERE account_id=?").run(next, acc.id);
    hub.emit({ type: "delivery.updated", accountId: acc.id, status: next });
  }
}

/** Etiqueta del cargo por servicio en la cuenta ("Servicio 10%"). */
async function serviceChargeLabel(db: Db): Promise<string> {
  const pct = (
    (await db.prepare("SELECT value FROM settings WHERE key='service_charge_pct'").get()) as
      | { value: string }
      | undefined
  )?.value;
  return pct ? `Servicio ${Number(pct)}%` : "Servicio";
}
