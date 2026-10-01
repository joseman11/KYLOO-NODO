import type { Permission } from "@003/shared";
import { DEFAULT_ROLE_PERMISSIONS, can, type Role } from "@003/shared";
import { verifySecret } from "./crypto";
import type { Db } from "./db";

export class HttpError extends Error {
  constructor(public statusCode: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

/** Subtotal vigente de una cuenta (precios con impuesto incluido; excluye cancelados). */
export function accountSubtotal(db: Db, accountId: string): number {
  const rows = db
    .prepare("SELECT quantity, unit_price_cents FROM order_items WHERE account_id=? AND status='activo'")
    .all(accountId) as { quantity: number; unit_price_cents: number }[];
  return rows.reduce((s, r) => s + r.quantity * r.unit_price_cents, 0);
}

export function accountDiscounts(db: Db, accountId: string): number {
  return (db.prepare("SELECT COALESCE(SUM(amount_cents),0) t FROM account_discounts WHERE account_id=?").get(accountId) as { t: number }).t;
}

export function deliveryFee(db: Db, accountId: string): number {
  return (db.prepare("SELECT fee_cents FROM delivery_info WHERE account_id=?").get(accountId) as { fee_cents: number } | undefined)?.fee_cents ?? 0;
}

const setting = (db: Db, key: string) => (db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined)?.value;

/**
 * Cargo por servicio (p. ej. 10 % en grupos de 8 o más). Se calcula sobre la cuenta ya con descuentos
 * y se puede dispensar por cuenta. Con porcentaje 0 (por omisión) no existe.
 */
export function serviceChargeCents(db: Db, accountId: string): number {
  const pct = Number(setting(db, "service_charge_pct") ?? 0);
  if (!(pct > 0)) return 0;
  const minGuests = Math.max(1, Number(setting(db, "service_charge_min_guests") ?? 1));
  const acc = db.prepare("SELECT guests, service_waived FROM accounts WHERE id=?").get(accountId) as { guests: number; service_waived: number } | undefined;
  if (!acc || acc.service_waived || acc.guests < minGuests) return 0;
  const base = Math.max(0, accountSubtotal(db, accountId) - accountDiscounts(db, accountId));
  return Math.round((base * pct) / 100);
}

/** Total a cobrar: subtotal − descuentos + cargo por servicio + costo de envío. Nunca negativo. */
export function accountTotal(db: Db, accountId: string): number {
  const subtotal = accountSubtotal(db, accountId);
  if (subtotal === 0) return 0;
  return Math.max(0, subtotal - accountDiscounts(db, accountId)) + serviceChargeCents(db, accountId) + deliveryFee(db, accountId);
}

/** Lo ya cobrado de la cuenta (pueden ser varios pagos: partes iguales o por asiento). */
export function accountPaid(db: Db, accountId: string): number {
  return (db.prepare("SELECT COALESCE(SUM(total_cents),0) t FROM payments WHERE account_id=?").get(accountId) as { t: number }).t;
}

export const accountBalance = (db: Db, accountId: string) => Math.max(0, accountTotal(db, accountId) - accountPaid(db, accountId));

/** Recalcula el estado de la mesa según sus cuentas abiertas. */
export function refreshTable(db: Db, tableId: string | null): string {
  if (!tableId) return "sin_mesa";
  // Las mesas unidas a una cuenta ya cerrada se liberan
  const stale = db
    .prepare("SELECT l.table_id FROM table_links l JOIN accounts a ON a.id=l.account_id WHERE a.status='cerrada'")
    .all() as { table_id: string }[];
  if (stale.length) {
    db.prepare("DELETE FROM table_links WHERE account_id IN (SELECT id FROM accounts WHERE status='cerrada')").run();
    for (const s of stale) if (s.table_id !== tableId) refreshTable(db, s.table_id);
  }
  const open = db
    .prepare(
      `SELECT status FROM accounts WHERE table_id=? AND status!='cerrada'
       UNION ALL SELECT a.status FROM table_links l JOIN accounts a ON a.id=l.account_id WHERE l.table_id=? AND a.status!='cerrada'`,
    )
    .all(tableId, tableId) as { status: string }[];
  const status = open.length === 0 ? "disponible" : open.every((a) => a.status === "pago_solicitado") ? "esperando_pago" : "ocupada";
  db.prepare("UPDATE tables_ SET status=?, version=version+1 WHERE id=? AND status NOT IN ('bloqueada','fuera_de_servicio')").run(status, tableId);
  return status;
}

/** Valida PIN de un usuario con el permiso requerido (autorización de gerente, RN-007 / sec. 16). */
export function authorize(db: Db, userId: string | undefined, pin: string | undefined, permission: Permission): string {
  if (!userId || !pin) throw new HttpError(403, "requiere_autorizacion", `Requiere autorización con permiso ${permission}`);
  const u = db.prepare("SELECT id, role, pin_hash, active FROM users WHERE id=?").get(userId) as
    | { id: string; role: Role; pin_hash: string | null; active: number }
    | undefined;
  if (!u || !u.active || !verifySecret(pin, u.pin_hash) || !can(DEFAULT_ROLE_PERMISSIONS[u.role], permission)) {
    throw new HttpError(403, "autorizacion_invalida");
  }
  return u.id;
}
