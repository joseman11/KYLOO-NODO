import type { Db } from "./db";
import { newId } from "./db";
import type { Hub } from "./hub";

export type MovementKind = "entrada" | "salida" | "ajuste" | "merma" | "venta" | "compra";

interface ItemRow {
  id: string;
  name: string;
  stock: number;
  min_stock: number;
  unit_cost_cents: number;
}

/** Redondeo para evitar ruido de coma flotante (0.1+0.2) en existencias. */
const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Registra un movimiento y actualiza stock. `quantity` lleva signo (+ entra, − sale).
 * El stock puede quedar negativo (se alerta, no se bloquea la venta).
 */
export function applyMovement(
  db: Db,
  itemId: string,
  kind: MovementKind,
  quantity: number,
  o: { reason?: string; userId?: string; ref?: string; unitCostCents?: number } = {},
): ItemRow {
  const item = db.prepare("SELECT id,name,stock,min_stock,unit_cost_cents FROM inventory_items WHERE id=?").get(itemId) as ItemRow | undefined;
  if (!item) throw new Error(`Insumo ${itemId} no existe`);
  const now = Date.now();
  const stock = round(item.stock + quantity);
  // Las entradas con costo recalculan el costo promedio ponderado
  let cost = item.unit_cost_cents;
  if (quantity > 0 && o.unitCostCents !== undefined) {
    cost = item.stock > 0 ? (item.stock * item.unit_cost_cents + quantity * o.unitCostCents) / (item.stock + quantity) : o.unitCostCents;
  }
  db.prepare("UPDATE inventory_items SET stock=?, unit_cost_cents=?, last_in=COALESCE(?,last_in), last_out=COALESCE(?,last_out) WHERE id=?").run(
    stock, cost, quantity > 0 ? now : null, quantity < 0 ? now : null, itemId,
  );
  db.prepare(
    "INSERT INTO inventory_movements (id,item_id,kind,quantity,unit_cost_cents,reason,user_id,ref,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(newId(), itemId, kind, quantity, o.unitCostCents ?? null, o.reason ?? null, o.userId ?? null, o.ref ?? null, now);
  return { ...item, stock, unit_cost_cents: cost };
}

export interface StockAlert {
  itemId: string;
  name: string;
  level: "bajo" | "agotado" | "negativo";
  stock: number;
}

export function alertFor(i: { id: string; name: string; stock: number; min_stock: number }): StockAlert | null {
  if (i.stock < 0) return { itemId: i.id, name: i.name, level: "negativo", stock: i.stock };
  if (i.stock === 0) return { itemId: i.id, name: i.name, level: "agotado", stock: i.stock };
  if (i.min_stock > 0 && i.stock <= i.min_stock) return { itemId: i.id, name: i.name, level: "bajo", stock: i.stock };
  return null;
}

/** Descuenta insumos según receta al enviar una comanda. Los productos sin receta no afectan inventario. */
export function consumeForItems(
  db: Db,
  items: { id: string; productId: string; quantity: number }[],
  userId: string,
): StockAlert[] {
  const alerts = new Map<string, StockAlert>();
  for (const it of items) {
    const lines = db.prepare("SELECT item_id, quantity FROM recipe_lines WHERE product_id=?").all(it.productId) as { item_id: string; quantity: number }[];
    for (const l of lines) {
      const after = applyMovement(db, l.item_id, "venta", -(l.quantity * it.quantity), { userId, ref: it.id });
      const a = alertFor(after);
      if (a) alerts.set(a.itemId, a);
    }
  }
  return [...alerts.values()];
}

/** Devuelve al inventario lo consumido por un ítem cancelado antes de producción. */
export function restoreForItem(db: Db, itemId: string, userId: string, reason: string): void {
  const moves = db.prepare("SELECT item_id, quantity FROM inventory_movements WHERE ref=? AND kind='venta'").all(itemId) as { item_id: string; quantity: number }[];
  for (const m of moves) applyMovement(db, m.item_id, "ajuste", -m.quantity, { userId, ref: itemId, reason: `Cancelación: ${reason}` });
}

export function emitAlerts(hub: Hub, alerts: StockAlert[]): void {
  for (const a of alerts) hub.emit({ type: "inventory.alert", ...a });
}
