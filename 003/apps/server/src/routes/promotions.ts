import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DEFAULT_ROLE_PERMISSIONS, type Role } from "@003/shared";
import { audit, newId, type Db } from "../db";
import { HttpError, accountDiscounts, accountSubtotal, authorize } from "../domain";
import { crud } from "./crud";

interface Promotion {
  id: string;
  name: string;
  kind: "porcentaje" | "monto" | "2x1" | "precio_especial";
  value: number;
  product_id: string | null;
  category_id: string | null;
  days: string | null;
  start_minute: number | null;
  end_minute: number | null;
  valid_from: number | null;
  valid_to: number | null;
  active: number;
}

interface Line {
  product_id: string;
  category_id: string | null;
  quantity: number;
  unit_price_cents: number;
}

/** ¿La promoción está vigente ahora? (fechas, día de la semana y horario, con cruce de medianoche). */
export function isPromoActive(p: Promotion, now = new Date()): boolean {
  if (!p.active) return false;
  const t = now.getTime();
  if (p.valid_from && t < p.valid_from) return false;
  if (p.valid_to && t > p.valid_to) return false;
  if (p.days && !p.days.split(",").map(Number).includes(now.getDay())) return false;
  if (p.start_minute !== null && p.end_minute !== null) {
    const m = now.getHours() * 60 + now.getMinutes();
    const inside =
      p.start_minute <= p.end_minute
        ? m >= p.start_minute && m < p.end_minute
        : m >= p.start_minute || m < p.end_minute;
    if (!inside) return false;
  }
  return true;
}

/** Monto de descuento (centavos) que una promoción otorga sobre las líneas de una cuenta. */
export function promoAmount(p: Promotion, lines: Line[]): number {
  const matched = lines.filter((l) =>
    p.product_id
      ? l.product_id === p.product_id
      : p.category_id
        ? l.category_id === p.category_id
        : true,
  );
  const matchedTotal = matched.reduce((s, l) => s + l.quantity * l.unit_price_cents, 0);
  switch (p.kind) {
    case "porcentaje":
      return Math.floor((matchedTotal * p.value) / 100);
    case "monto":
      return matched.length ? Math.min(p.value, matchedTotal) : 0;
    case "2x1": {
      // Por producto: cada 2 unidades, la más barata es gratis
      const byProduct = new Map<string, { qty: number; unit: number }>();
      for (const l of matched) {
        const cur = byProduct.get(l.product_id);
        byProduct.set(l.product_id, {
          qty: (cur?.qty ?? 0) + l.quantity,
          unit: cur ? Math.min(cur.unit, l.unit_price_cents) : l.unit_price_cents,
        });
      }
      return [...byProduct.values()].reduce((s, v) => s + Math.floor(v.qty / 2) * v.unit, 0);
    }
    case "precio_especial":
      return matched.reduce(
        (s, l) => s + Math.max(0, l.unit_price_cents - p.value) * l.quantity,
        0,
      );
  }
}

const discountLimitPct = async (db: Db) =>
  Number(
    (
      (await db.prepare("SELECT value FROM settings WHERE key='discount_limit_pct'").get()) as
        | { value: string }
        | undefined
    )?.value ?? 10,
  );

/** Descuentos manuales y promociones (Fase 2, sec. 33 y 46). */
export async function promotionRoutes(app: FastifyInstance) {
  const { db, hub } = app;
  const id = z.object({ id: z.string() });

  crud(app, {
    path: "/api/promotions",
    table: "promotions",
    entity: "promocion",
    write: "promotion.manage",
    orderBy: "name",
    shape: {
      name: z.string().min(1),
      kind: z.enum(["porcentaje", "monto", "2x1", "precio_especial"]),
      value: z.number().int().min(0).default(0),
      product_id: z.string().nullable().optional(),
      category_id: z.string().nullable().optional(),
      days: z
        .string()
        .regex(/^[0-6](,[0-6])*$/)
        .nullable()
        .optional(),
      start_minute: z.number().int().min(0).max(1439).nullable().optional(),
      end_minute: z.number().int().min(0).max(1439).nullable().optional(),
      valid_from: z.number().int().nullable().optional(),
      valid_to: z.number().int().nullable().optional(),
      active: z.boolean().default(true),
    },
  });

  const openAccount = async (accountId: string) => {
    const a = (await db.prepare("SELECT id, status FROM accounts WHERE id=?").get(accountId)) as
      | { id: string; status: string }
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
  const lines = async (accountId: string) =>
    (await db
      .prepare(
        `SELECT i.product_id, p.category_id, i.quantity, i.unit_price_cents FROM order_items i JOIN products p ON p.id=i.product_id
         WHERE i.account_id=? AND i.status='activo'`,
      )
      .all(accountId)) as Line[];
  const room = async (accountId: string) =>
    Math.max(0, (await accountSubtotal(db, accountId)) - (await accountDiscounts(db, accountId)));

  // Promociones vigentes que aplican a la cuenta, con el ahorro calculado
  app.get("/api/accounts/:id/promotions", { preHandler: app.authorize() }, async (req) => {
    const { id: accountId } = id.parse(req.params);
    await openAccount(accountId);
    const applied = new Set(
      (
        (await db
          .prepare(
            "SELECT promotion_id FROM account_discounts WHERE account_id=? AND promotion_id IS NOT NULL",
          )
          .all(accountId)) as { promotion_id: string }[]
      ).map((r) => r.promotion_id),
    );
    const ls = await lines(accountId);
    return ((await db.prepare("SELECT * FROM promotions").all()) as Promotion[])
      .filter((p) => isPromoActive(p) && !applied.has(p.id))
      .map((p) => ({ id: p.id, name: p.name, kind: p.kind, amount_cents: promoAmount(p, ls) }))
      .filter((p) => p.amount_cents > 0);
  });

  app.post(
    "/api/accounts/:id/promotions/:promoId/apply",
    { preHandler: app.authorize() },
    async (req, reply) => {
      const { id: accountId, promoId } = z
        .object({ id: z.string(), promoId: z.string() })
        .parse(req.params);
      await openAccount(accountId);
      const p = (await db.prepare("SELECT * FROM promotions WHERE id=?").get(promoId)) as
        | Promotion
        | undefined;
      if (!p || !isPromoActive(p)) throw new HttpError(409, "promocion_no_vigente");
      const amount = Math.min(promoAmount(p, await lines(accountId)), await room(accountId));
      if (amount <= 0)
        throw new HttpError(409, "promocion_no_aplica", "La cuenta no cumple las condiciones");
      const did = newId();
      await db
        .prepare(
          "INSERT INTO account_discounts (id,account_id,kind,value,amount_cents,reason,promotion_id,user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(did, accountId, "promocion", p.value, amount, p.name, p.id, req.user.sub, Date.now());
      await audit(db, req.user.sub, "aplicar_promocion", "account", accountId, {
        promotion: p.name,
        amount,
      });
      hub.emit({ type: "order.updated", accountId });
      return reply.code(201).send({ id: did, amount_cents: amount });
    },
  );

  // Descuento manual: sobre el límite configurado exige autorización (RN-007)
  app.post("/api/accounts/:id/discounts", { preHandler: app.authorize() }, async (req, reply) => {
    const { id: accountId } = id.parse(req.params);
    const b = z
      .object({
        kind: z.enum(["porcentaje", "monto"]),
        value: z.number().int().min(1),
        reason: z.string().min(2),
        authorizerId: z.string().optional(),
        authorizerPin: z.string().optional(),
      })
      .parse(req.body);
    await openAccount(accountId);
    const subtotal = await accountSubtotal(db, accountId);
    if (b.kind === "porcentaje" && b.value > 100)
      throw new HttpError(400, "validacion", "El porcentaje no puede superar 100");
    const amount = Math.min(
      b.kind === "porcentaje" ? Math.floor((subtotal * b.value) / 100) : b.value,
      await room(accountId),
    );
    if (amount <= 0) throw new HttpError(409, "descuento_nulo");

    const pct = subtotal ? (amount / subtotal) * 100 : 0;
    let authorizedBy: string | null = null;
    if (pct > (await discountLimitPct(db))) {
      const own = DEFAULT_ROLE_PERMISSIONS[req.user.role as Role]?.includes("discount.apply");
      authorizedBy = own
        ? req.user.sub
        : await authorize(db, b.authorizerId, b.authorizerPin, "discount.apply");
    }
    const did = newId();
    await db
      .prepare(
        "INSERT INTO account_discounts (id,account_id,kind,value,amount_cents,reason,user_id,authorized_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        did,
        accountId,
        b.kind,
        b.value,
        amount,
        b.reason,
        req.user.sub,
        authorizedBy,
        Date.now(),
      );
    await audit(db, req.user.sub, "descuento", "account", accountId, {
      kind: b.kind,
      value: b.value,
      amount,
      authorizedBy,
      reason: b.reason,
    });
    hub.emit({ type: "order.updated", accountId });
    return reply.code(201).send({ id: did, amount_cents: amount });
  });

  app.delete(
    "/api/accounts/:id/discounts/:did",
    { preHandler: app.authorize("discount.apply") },
    async (req) => {
      const { id: accountId, did } = z
        .object({ id: z.string(), did: z.string() })
        .parse(req.params);
      await openAccount(accountId);
      const r = await db
        .prepare("DELETE FROM account_discounts WHERE id=? AND account_id=?")
        .run(did, accountId);
      if (r.changes === 0) throw new HttpError(404, "no_encontrado");
      await audit(db, req.user.sub, "quitar_descuento", "account", accountId, { did });
      hub.emit({ type: "order.updated", accountId });
      return { ok: true };
    },
  );
}
