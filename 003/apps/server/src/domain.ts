import type { Permission } from "@003/shared";
import { DEFAULT_ROLE_PERMISSIONS, can, type Role } from "@003/shared";
import { verifySecret } from "./crypto";
import type { Db } from "./db";

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** Subtotal vigente de una cuenta (precios con impuesto incluido; excluye cancelados). */
export async function accountSubtotal(db: Db, accountId: string): Promise<number> {
  const rows = (await db
    .prepare(
      "SELECT quantity, unit_price_cents FROM order_items WHERE account_id=? AND status='activo'",
    )
    .all(accountId)) as { quantity: number; unit_price_cents: number }[];
  return rows.reduce((s, r) => s + r.quantity * r.unit_price_cents, 0);
}

export async function accountDiscounts(db: Db, accountId: string): Promise<number> {
  return (
    (await db
      .prepare("SELECT COALESCE(SUM(amount_cents),0) t FROM account_discounts WHERE account_id=?")
      .get(accountId)) as { t: number }
  ).t;
}

export async function deliveryFee(db: Db, accountId: string): Promise<number> {
  return (
    (
      (await db.prepare("SELECT fee_cents FROM delivery_info WHERE account_id=?").get(accountId)) as
        | { fee_cents: number }
        | undefined
    )?.fee_cents ?? 0
  );
}

const setting = async (db: Db, key: string) =>
  (
    (await db.prepare("SELECT value FROM settings WHERE key=?").get(key)) as
      | { value: string }
      | undefined
  )?.value;

/**
 * Cargo por servicio (p. ej. 10 % en grupos de 8 o más). Se calcula sobre la cuenta ya con descuentos
 * y se puede dispensar por cuenta. Con porcentaje 0 (por omisión) no existe.
 */
export async function serviceChargeCents(db: Db, accountId: string): Promise<number> {
  const pct = Number((await setting(db, "service_charge_pct")) ?? 0);
  if (!(pct > 0)) return 0;
  const minGuests = Math.max(1, Number((await setting(db, "service_charge_min_guests")) ?? 1));
  const acc = (await db
    .prepare("SELECT guests, service_waived FROM accounts WHERE id=?")
    .get(accountId)) as { guests: number; service_waived: number } | undefined;
  if (!acc || acc.service_waived || acc.guests < minGuests) return 0;
  const base = Math.max(
    0,
    (await accountSubtotal(db, accountId)) - (await accountDiscounts(db, accountId)),
  );
  return Math.round((base * pct) / 100);
}

/** Total a cobrar: subtotal − descuentos + cargo por servicio + costo de envío. Nunca negativo. */
export async function accountTotal(db: Db, accountId: string): Promise<number> {
  const subtotal = await accountSubtotal(db, accountId);
  if (subtotal === 0) return 0;
  return (
    Math.max(0, subtotal - (await accountDiscounts(db, accountId))) +
    (await serviceChargeCents(db, accountId)) +
    (await deliveryFee(db, accountId))
  );
}

/** Lo ya cobrado de la cuenta (pueden ser varios pagos: partes iguales o por asiento). */
export async function accountPaid(db: Db, accountId: string): Promise<number> {
  return (
    (await db
      .prepare("SELECT COALESCE(SUM(total_cents),0) t FROM payments WHERE account_id=?")
      .get(accountId)) as { t: number }
  ).t;
}

export const accountBalance = async (db: Db, accountId: string) =>
  Math.max(0, (await accountTotal(db, accountId)) - (await accountPaid(db, accountId)));

/** Recalcula el estado de la mesa según sus cuentas abiertas. */
export async function refreshTable(db: Db, tableId: string | null): Promise<string> {
  if (!tableId) return "sin_mesa";
  // Las mesas unidas a una cuenta ya cerrada se liberan
  const stale = (await db
    .prepare(
      "SELECT l.table_id FROM table_links l JOIN accounts a ON a.id=l.account_id WHERE a.status='cerrada'",
    )
    .all()) as { table_id: string }[];
  if (stale.length) {
    await db
      .prepare(
        "DELETE FROM table_links WHERE account_id IN (SELECT id FROM accounts WHERE status='cerrada')",
      )
      .run();
    for (const s of stale) if (s.table_id !== tableId) await refreshTable(db, s.table_id);
  }
  const open = (await db
    .prepare(
      `SELECT status FROM accounts WHERE table_id=? AND status!='cerrada'
       UNION ALL SELECT a.status FROM table_links l JOIN accounts a ON a.id=l.account_id WHERE l.table_id=? AND a.status!='cerrada'`,
    )
    .all(tableId, tableId)) as { status: string }[];
  const status =
    open.length === 0
      ? "disponible"
      : open.every((a) => a.status === "pago_solicitado")
        ? "esperando_pago"
        : "ocupada";
  await db
    .prepare(
      "UPDATE tables_ SET status=?, version=version+1 WHERE id=? AND status NOT IN ('bloqueada','fuera_de_servicio')",
    )
    .run(status, tableId);
  return status;
}

/** Valida PIN de un usuario con el permiso requerido (autorización de gerente, RN-007 / sec. 16). */
export async function authorize(
  db: Db,
  userId: string | undefined,
  pin: string | undefined,
  permission: Permission,
): Promise<string> {
  if (!userId || !pin)
    throw new HttpError(
      403,
      "requiere_autorizacion",
      `Requiere autorización con permiso ${permission}`,
    );
  const u = (await db
    .prepare("SELECT id, role, pin_hash, active FROM users WHERE id=?")
    .get(userId)) as
    | { id: string; role: Role; pin_hash: string | null; active: number }
    | undefined;
  if (
    !u ||
    !u.active ||
    !verifySecret(pin, u.pin_hash) ||
    !can(DEFAULT_ROLE_PERMISSIONS[u.role], permission)
  ) {
    throw new HttpError(403, "autorizacion_invalida");
  }
  return u.id;
}
