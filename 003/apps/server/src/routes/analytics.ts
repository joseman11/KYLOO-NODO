import type { FastifyInstance } from "fastify";
import { z } from "zod";

const DAY = 86_400_000;
const LATE_MINUTES = 15;

const startOfToday = () => new Date().setHours(0, 0, 0, 0);
const range = z.object({ from: z.coerce.number().optional(), to: z.coerce.number().optional() });

/** Rango pedido (por defecto, los últimos 7 días) y el periodo anterior de la misma duración. */
function resolve(q: z.infer<typeof range>) {
  const to = q.to ?? Date.now() + 1;
  const from = q.from ?? startOfToday() - 6 * DAY;
  const span = Math.max(1, to - from);
  return { from, to, prevFrom: from - span, prevTo: from };
}

const pct = (cur: number, prev: number) =>
  prev === 0 ? (cur === 0 ? 0 : null) : Math.round(((cur - prev) / prev) * 1000) / 10;

/** Analítica avanzada (Fase 3, sec. 78): métricas operativas, ABC y pronóstico simple. */
export async function analyticsRoutes(app: FastifyInstance) {
  const { db } = app;
  const guard = { preHandler: app.authorize("reports.view") };

  app.get("/api/analytics/overview", guard, async (req) => {
    const { from, to, prevFrom, prevTo } = resolve(range.parse(req.query));
    const sales = async (a: number, b: number) =>
      (await db
        .prepare(
          "SELECT COUNT(DISTINCT account_id) tickets, COALESCE(SUM(total_cents),0) sales_cents, COALESCE(SUM(tip_cents),0) tips_cents FROM payments WHERE created_at>=? AND created_at<?",
        )
        .get(a, b)) as { tickets: number; sales_cents: number; tips_cents: number };
    const cur = await sales(from, to);
    const prev = await sales(prevFrom, prevTo);

    const orders = (await db
      .prepare(
        `SELECT COUNT(DISTINCT o.id) orders, COALESCE(SUM(i.quantity),0) units FROM orders o JOIN order_items i ON i.order_id=o.id
         WHERE o.created_at>=? AND o.created_at<? AND i.status='activo'`,
      )
      .get(from, to)) as { orders: number; units: number };

    const served = (await db
      .prepare(
        `SELECT COUNT(DISTINCT p.account_id) n, AVG((p.created_at - a.opened_at)/60000.0) minutes FROM payments p JOIN accounts a ON a.id=p.account_id
         WHERE p.created_at>=? AND p.created_at<? AND a.kind='mesa'`,
      )
      .get(from, to)) as { n: number; minutes: number | null };
    const tables =
      ((await db.prepare("SELECT COUNT(*) c FROM tables_").get()) as { c: number }).c || 1;
    const days = Math.max(1, Math.round((to - from) / DAY));

    const discounts = (
      (await db
        .prepare(
          "SELECT COALESCE(SUM(amount_cents),0) t FROM account_discounts WHERE created_at>=? AND created_at<?",
        )
        .get(from, to)) as { t: number }
    ).t;
    const cancelled = (await db
      .prepare(
        `SELECT COUNT(*) items, COALESCE(SUM(i.quantity*i.unit_price_cents),0) total_cents,
                COALESCE(SUM(i.cancelled_after_production),0) after_production
         FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.status='cancelado' AND o.created_at>=? AND o.created_at<?`,
      )
      .get(from, to)) as { items: number; total_cents: number; after_production: number };
    const waste = (
      (await db
        .prepare(
          `SELECT COALESCE(SUM(-m.quantity * COALESCE(i.unit_cost_cents,0)),0) cost FROM inventory_movements m JOIN inventory_items i ON i.id=m.item_id
           WHERE m.kind='merma' AND m.created_at>=? AND m.created_at<?`,
        )
        .get(from, to)) as { cost: number }
    ).cost;

    return {
      from,
      to,
      tickets: cur.tickets,
      sales_cents: cur.sales_cents,
      tips_cents: cur.tips_cents,
      discounts_cents: discounts,
      average_ticket_cents: cur.tickets ? Math.round(cur.sales_cents / cur.tickets) : 0,
      items_per_order: orders.orders ? Math.round((orders.units / orders.orders) * 10) / 10 : 0,
      tables_served: served.n,
      table_rotation: Math.round((served.n / tables / days) * 100) / 100,
      avg_attention_minutes: served.minutes === null ? null : Math.round(served.minutes),
      cancellations: cancelled,
      waste_cost_cents: Math.round(waste),
      previous: { sales_cents: prev.sales_cents, tickets: prev.tickets },
      change_sales_pct: pct(cur.sales_cents, prev.sales_cents),
      change_tickets_pct: pct(cur.tickets, prev.tickets),
      by_hour: await db
        .prepare(
          `SELECT CAST(strftime('%H', created_at/1000,'unixepoch','localtime') AS INTEGER) AS hour, COUNT(DISTINCT account_id) tickets, SUM(total_cents) sales_cents
           FROM payments WHERE created_at>=? AND created_at<? GROUP BY hour ORDER BY hour`,
        )
        .all(from, to),
      by_weekday: await db
        .prepare(
          `SELECT CAST(strftime('%w', created_at/1000,'unixepoch','localtime') AS INTEGER) weekday, COUNT(DISTINCT account_id) tickets, SUM(total_cents) sales_cents
           FROM payments WHERE created_at>=? AND created_at<? GROUP BY weekday ORDER BY weekday`,
        )
        .all(from, to),
    };
  });

  // Tiempos por estación: envío → listo (sec. 55 y 78)
  app.get("/api/analytics/prep-times", guard, async (req) => {
    const { from, to } = resolve(range.parse(req.query));
    return db
      .prepare(
        `SELECT s.name AS station, COUNT(*) tickets,
                ROUND(AVG((pt.ready_at - pt.created_at)/60000.0), 1) avg_minutes,
                ROUND(MAX((pt.ready_at - pt.created_at)/60000.0), 1) max_minutes,
                SUM(CASE WHEN (pt.ready_at - pt.created_at) > ? THEN 1 ELSE 0 END) late
         FROM production_tickets pt JOIN stations s ON s.id=pt.station_id
         WHERE pt.ready_at IS NOT NULL AND pt.created_at>=? AND pt.created_at<? GROUP BY s.id ORDER BY avg_minutes DESC`,
      )
      .all(LATE_MINUTES * 60_000, from, to);
  });

  // Análisis ABC: A = primeros productos que suman 80 % de la venta, B hasta 95 %, C el resto
  app.get("/api/analytics/abc", guard, async (req) => {
    const { from, to } = resolve(range.parse(req.query));
    const rows = (await db
      .prepare(
        `SELECT i.name product, SUM(i.quantity) units, SUM(i.quantity*i.unit_price_cents) sales_cents
         FROM order_items i JOIN orders o ON o.id=i.order_id
         WHERE i.status='activo' AND o.created_at>=? AND o.created_at<? AND i.account_id IN (SELECT account_id FROM payments)
         GROUP BY i.product_id, i.name ORDER BY sales_cents DESC`,
      )
      .all(from, to)) as { product: string; units: number; sales_cents: number }[];
    const total = rows.reduce((s, r) => s + r.sales_cents, 0);
    let acc = 0;
    return rows.map((r) => {
      const before = total ? acc / total : 0;
      acc += r.sales_cents;
      return {
        ...r,
        share_pct: total ? Math.round((r.sales_cents / total) * 1000) / 10 : 0,
        class: before < 0.8 ? "A" : before < 0.95 ? "B" : "C",
      };
    });
  });

  // Pronóstico simple: promedio por día de la semana de las últimas N semanas con datos
  app.get("/api/analytics/forecast", guard, async (req) => {
    const { weeks } = z
      .object({ weeks: z.coerce.number().int().min(1).max(26).default(8) })
      .parse(req.query);
    const since = startOfToday() - weeks * 7 * DAY;
    const perDay = (await db
      .prepare(
        `SELECT CAST(strftime('%w', created_at/1000,'unixepoch','localtime') AS INTEGER) weekday,
                strftime('%Y-%m-%d', created_at/1000,'unixepoch','localtime') AS day, COUNT(DISTINCT account_id) tickets, SUM(total_cents) sales_cents
         FROM payments WHERE created_at>=? GROUP BY weekday, day`,
      )
      .all(since)) as { weekday: number; day: string; tickets: number; sales_cents: number }[];
    const peak = (await db
      .prepare(
        `SELECT CAST(strftime('%w', created_at/1000,'unixepoch','localtime') AS INTEGER) weekday,
                CAST(strftime('%H', created_at/1000,'unixepoch','localtime') AS INTEGER) AS hour, SUM(total_cents) sales_cents
         FROM payments WHERE created_at>=? GROUP BY weekday, hour`,
      )
      .all(since)) as { weekday: number; hour: number; sales_cents: number }[];

    const out = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(startOfToday() + i * DAY);
      const wd = date.getDay();
      const samples = perDay.filter((d) => d.weekday === wd);
      const hours = peak
        .filter((p) => p.weekday === wd)
        .sort((a, b) => b.sales_cents - a.sales_cents);
      out.push({
        date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
        weekday: wd,
        samples: samples.length,
        expected_sales_cents: samples.length
          ? Math.round(samples.reduce((s, d) => s + d.sales_cents, 0) / samples.length)
          : null,
        expected_tickets: samples.length
          ? Math.round(samples.reduce((s, d) => s + d.tickets, 0) / samples.length)
          : null,
        peak_hour: hours[0]?.hour ?? null,
      });
    }
    return out;
  });
}
