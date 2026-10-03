import { routeOrder, type OrderItem } from "@003/shared";
import { newId, type Db } from "./db";
import { enqueue } from "./printing/queue";
import { renderComanda } from "./printing/render";
import { ticketStyle } from "./ticket-style";

interface RouteRow {
  station_id: string;
  area: string;
  subarea: string;
  p1: string | null;
  p2: string | null;
}

/** Estaciones a las que se envía un producto (con sus impresoras principal y secundaria). */
export async function routesFor(db: Db, productId: string): Promise<OrderItem["routes"]> {
  const rows = (await db
    .prepare(
      `SELECT s.id AS station_id, a.name AS area, sa.name AS subarea, s.primary_printer_id AS p1, s.secondary_printer_id AS p2
       FROM product_routes pr JOIN stations s ON s.id=pr.station_id JOIN subareas sa ON sa.id=s.subarea_id
       JOIN areas a ON a.id=sa.area_id WHERE pr.product_id=?`,
    )
    .all(productId)) as RouteRow[];
  return rows.map((r) => ({
    area: r.area,
    subarea: r.subarea,
    stationId: r.station_id,
    printerIds: [r.p1, r.p2].filter((x): x is string => !!x),
  }));
}

interface ItemRow {
  id: string;
  order_id: string;
  product_id: string;
  name: string;
  quantity: number;
  modifiers: string;
  note: string | null;
  course: string | null;
  seat: number | null;
}

/** Reconstruye los renglones de la comanda desde la base (para mandar a producir lo que estaba retenido). */
export async function loadRouted(
  db: Db,
  itemIds: string[],
): Promise<{ orderId: string; item: OrderItem }[]> {
  if (itemIds.length === 0) return [];
  const rows = (await db
    .prepare(
      `SELECT id, order_id, product_id, name, quantity, modifiers, note, course, seat FROM order_items WHERE id IN (${itemIds.map(() => "?").join(",")}) ORDER BY rowid`,
    )
    .all(...itemIds)) as ItemRow[];
  return Promise.all(
    rows.map(async (r) => ({
      orderId: r.order_id,
      item: {
        id: r.id,
        productId: r.product_id,
        name: r.name,
        quantity: r.quantity,
        modifiers: JSON.parse(r.modifiers) as string[],
        ...(r.note ? { note: r.note } : {}),
        ...(r.course ? { course: r.course } : {}),
        ...(r.seat ? { seat: r.seat } : {}),
        routes: await routesFor(db, r.product_id),
      },
    })),
  );
}

export interface ProduceOptions {
  orderId: string;
  routed: OrderItem[];
  kind: "comanda" | "adicion" | "tiempo";
  tableLabel: string;
  waiter: string;
  folio: number;
  createdAt: number;
  headline?: string;
}

/**
 * Motor de producción: un ticket por estación (sec. 12) y su impresión. Se usa al enviar una comanda
 * y al disparar un tiempo retenido. Debe llamarse dentro de una transacción.
 */
export async function produce(db: Db, o: ProduceOptions): Promise<void> {
  const style = await ticketStyle(db);
  for (const t of routeOrder(o.routed)) {
    const ticketId = newId();
    await db
      .prepare(
        "INSERT INTO production_tickets (id,order_id,station_id,created_at) VALUES (?,?,?,?)",
      )
      .run(ticketId, o.orderId, t.stationId, o.createdAt);
    for (const l of t.lines)
      await db
        .prepare("INSERT INTO ticket_lines (ticket_id,item_id) VALUES (?,?)")
        .run(ticketId, l.itemId);
    const [primary, secondary] = t.printerIds;
    if (!primary) continue; // estación solo con pantalla (KDS)
    const width =
      (
        (await db.prepare("SELECT paper_width FROM printers WHERE id=?").get(primary)) as
          | { paper_width: number }
          | undefined
      )?.paper_width ?? 80;
    await enqueue(db, {
      kind: o.kind === "tiempo" ? "comanda" : o.kind,
      ticketId,
      printerId: primary,
      fallbackPrinterId: secondary ?? null,
      lines: renderComanda(
        {
          kind: o.kind,
          headline: o.headline,
          stationLabel: `${t.area} / ${t.subarea}`,
          tableNumber: o.tableLabel,
          waiter: o.waiter,
          folio: o.folio,
          createdAt: o.createdAt,
          lines: t.lines.map((l) => ({
            quantity: l.quantity,
            name: l.name,
            modifiers: l.modifiers,
            note: l.note,
            course: l.course,
            seat: l.seat,
          })),
        },
        width,
        style,
      ),
    });
  }
}
