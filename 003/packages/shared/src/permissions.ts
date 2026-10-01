export const PERMISSIONS = [
  "order.create",
  "order.edit",
  "order.cancel",
  "item.cancel",
  "discount.apply",
  "price.change",
  "cash.open",
  "cash.close",
  "cash.withdraw",
  "payment.take",
  "drawer.open",
  "ticket.reprint",
  "comanda.reprint",
  "table.change",
  "table.transfer",
  "bill.split",
  "bill.merge",
  "refund.authorize",
  "inventory.modify",
  "inventory.view",
  "purchase.manage",
  "promotion.manage",
  "reservation.manage",
  "invoice.manage",
  "product.create",
  "product.modify",
  "reports.view",
  "data.export",
  "printer.manage",
  "venue.manage",
  "user.manage",
  "station.update",
  "item.mark_ready",
  "item.mark_delivered",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = [
  "admin",
  "gerente",
  "encargado_caja",
  "mesero",
  "cajero",
  "cocina",
  "bar",
  "supervisor",
] as const;

export type Role = (typeof ROLES)[number];

/** Permisos por defecto de cada rol base (sec. 4). Configurables por establecimiento. */
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  gerente: [
    "order.create", "order.edit", "order.cancel", "item.cancel", "discount.apply",
    "cash.close", "payment.take", "ticket.reprint", "comanda.reprint", "table.change", "table.transfer",
    "bill.split", "bill.merge", "refund.authorize", "reports.view", "data.export",
    "inventory.view", "inventory.modify", "purchase.manage", "promotion.manage", "reservation.manage", "invoice.manage",
  ],
  encargado_caja: [
    "cash.open", "cash.close", "cash.withdraw", "payment.take", "drawer.open", "ticket.reprint", "reports.view", "inventory.view", "invoice.manage",
  ],
  mesero: [
    "order.create", "order.edit", "item.cancel", "item.mark_delivered", "table.change", "table.transfer", "bill.split", "bill.merge", "reservation.manage",
  ],
  cajero: ["cash.open", "cash.close", "payment.take", "drawer.open", "ticket.reprint", "invoice.manage"],
  cocina: ["comanda.reprint", "item.mark_ready", "item.mark_delivered", "station.update"],
  bar: ["item.mark_ready", "station.update"],
  supervisor: ["reports.view", "comanda.reprint", "ticket.reprint", "inventory.view"],
};

export function can(granted: readonly Permission[], needed: Permission): boolean {
  return granted.includes(needed);
}
