import type { Permission } from "./permissions";

export type OrderStatus =
  | "borrador"
  | "enviada"
  | "recibida"
  | "en_preparacion"
  | "preparada"
  | "entregada"
  | "facturada"
  | "cancelada"
  | "rechazada"
  | "devuelta";

interface Transition {
  to: OrderStatus;
  /** Permiso requerido; undefined = cualquier usuario autenticado con acceso a la mesa. */
  permission?: Permission;
}

const TRANSITIONS: Record<OrderStatus, Transition[]> = {
  borrador: [
    { to: "enviada", permission: "order.create" },
    { to: "cancelada", permission: "order.cancel" },
  ],
  enviada: [
    { to: "recibida", permission: "station.update" },
    { to: "rechazada", permission: "station.update" },
    { to: "cancelada", permission: "order.cancel" },
  ],
  recibida: [
    { to: "en_preparacion", permission: "station.update" },
    { to: "cancelada", permission: "order.cancel" },
  ],
  en_preparacion: [
    { to: "preparada", permission: "item.mark_ready" },
    { to: "cancelada", permission: "order.cancel" },
  ],
  preparada: [
    { to: "entregada", permission: "item.mark_delivered" },
    { to: "devuelta", permission: "refund.authorize" },
  ],
  entregada: [
    { to: "facturada", permission: "cash.open" },
    { to: "devuelta", permission: "refund.authorize" },
  ],
  facturada: [],
  cancelada: [],
  rechazada: [],
  devuelta: [],
};

export function allowedTransitions(from: OrderStatus): readonly Transition[] {
  return TRANSITIONS[from];
}

export type TransitionResult =
  | { ok: true }
  | { ok: false; reason: "invalid_transition" | "forbidden" };

/** Valida una transición contra la máquina de estados y los permisos del usuario (sec. 69, RN-015). */
export function checkTransition(
  from: OrderStatus,
  to: OrderStatus,
  granted: readonly Permission[],
): TransitionResult {
  const t = TRANSITIONS[from].find((x) => x.to === to);
  if (!t) return { ok: false, reason: "invalid_transition" };
  if (t.permission && !granted.includes(t.permission)) return { ok: false, reason: "forbidden" };
  return { ok: true };
}
