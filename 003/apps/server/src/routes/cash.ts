import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, newId, type Db } from "../db";
import { HttpError, accountBalance, accountPaid, accountSubtotal, accountTotal, authorize, refreshTable } from "../domain";
import { enqueue } from "../printing/queue";
import { billLines } from "./operations";
import type { Hub } from "../hub";

const METHODS = ["efectivo", "tarjeta", "transferencia", "qr", "credito", "regalo", "otro"] as const;

interface Session {
  id: string;
  user_id: string;
  opening_cents: number;
  opened_at: number;
  status: string;
}

export function sessionSummary(db: Db, s: Session) {
  const byMethod = db
    .prepare(
      `SELECT pl.method, SUM(pl.amount_cents) total FROM payment_lines pl JOIN payments p ON p.id=pl.payment_id
       WHERE p.session_id=? GROUP BY pl.method`,
    )
    .all(s.id) as { method: string; total: number }[];
  const sum = (m: string) => byMethod.find((r) => r.method === m)?.total ?? 0;
  const tips = db
    .prepare("SELECT tip_method, SUM(tip_cents) total FROM payments WHERE session_id=? AND tip_cents>0 GROUP BY tip_method")
    .all(s.id) as { tip_method: string | null; total: number }[];
  const cashTips = tips.filter((t) => t.tip_method === "efectivo").reduce((a, t) => a + t.total, 0);
  const moves = db.prepare("SELECT kind, SUM(amount_cents) total FROM cash_movements WHERE session_id=? GROUP BY kind").all(s.id) as { kind: string; total: number }[];
  const withdrawals = moves.find((m) => m.kind === "retiro")?.total ?? 0;
  const incomes = moves.find((m) => m.kind === "ingreso")?.total ?? 0;
  const sales = byMethod.reduce((a, r) => a + r.total, 0);
  const cancelled = db
    .prepare(
      `SELECT COUNT(*) n, COALESCE(SUM(quantity*unit_price_cents),0) total FROM order_items
       WHERE status='cancelado' AND cancelled_by IS NOT NULL AND account_id IN (SELECT account_id FROM payments WHERE session_id=?)`,
    )
    .get(s.id) as { n: number; total: number };
  return {
    opening_cents: s.opening_cents,
    sales_cents: sales,
    by_method: Object.fromEntries(byMethod.map((r) => [r.method, r.total])),
    tips_cents: tips.reduce((a, t) => a + t.total, 0),
    cash_tips_cents: cashTips,
    withdrawals_cents: withdrawals,
    incomes_cents: incomes,
    cancelled_items: cancelled.n,
    expected_cash_cents: s.opening_cents + sum("efectivo") + cashTips + incomes - withdrawals,
  };
}

export async function cashRoutes(app: FastifyInstance, opts: { hub: Hub }) {
  const { db } = app;
  const { hub } = opts;

  const currentSession = (userId: string) =>
    db.prepare("SELECT * FROM cash_sessions WHERE user_id=? AND status='abierta'").get(userId) as Session | undefined;

  app.post("/api/cash/open", { preHandler: app.authorize("cash.open") }, async (req, reply) => {
    const b = z.object({ opening_cents: z.number().int().min(0), notes: z.string().optional(), name: z.string().default("Caja 1") }).parse(req.body);
    if (currentSession(req.user.sub)) throw new HttpError(409, "caja_ya_abierta");
    const id = newId();
    db.prepare("INSERT INTO cash_sessions (id,user_id,name,opening_cents,opened_at,notes) VALUES (?,?,?,?,?,?)").run(
      id, req.user.sub, b.name, b.opening_cents, Date.now(), b.notes ?? null,
    );
    audit(db, req.user.sub, "abrir_caja", "cash_session", id, { opening_cents: b.opening_cents });
    return reply.code(201).send({ id });
  });

  // Corte parcial: resumen en vivo de la sesión abierta
  app.get("/api/cash/current", { preHandler: app.authorize() }, async (req, reply) => {
    const s = currentSession(req.user.sub);
    if (!s) return reply.code(404).send({ error: "caja_cerrada" });
    return { session: s, summary: sessionSummary(db, s) };
  });

  app.post("/api/cash/movements", { preHandler: app.authorize() }, async (req, reply) => {
    const b = z
      .object({
        kind: z.enum(["retiro", "ingreso"]),
        amount_cents: z.number().int().min(1),
        reason: z.string().min(2),
        authorizerId: z.string().optional(),
        authorizerPin: z.string().optional(),
      })
      .parse(req.body);
    const s = currentSession(req.user.sub);
    if (!s) throw new HttpError(409, "caja_cerrada");
    let authorizedBy: string | null = null;
    if (b.kind === "retiro") {
      if (!req.user.permissions.includes("cash.withdraw")) authorizedBy = authorize(db, b.authorizerId, b.authorizerPin, "cash.withdraw");
      const { expected_cash_cents } = sessionSummary(db, s);
      if (b.amount_cents > expected_cash_cents) throw new HttpError(409, "efectivo_insuficiente");
    } else if (!req.user.permissions.includes("cash.open")) {
      throw new HttpError(403, "sin_permiso", "cash.open");
    }
    const id = newId();
    db.prepare("INSERT INTO cash_movements (id,session_id,kind,amount_cents,reason,user_id,authorized_by,created_at) VALUES (?,?,?,?,?,?,?,?)").run(
      id, s.id, b.kind, b.amount_cents, b.reason, req.user.sub, authorizedBy, Date.now(),
    );
    audit(db, req.user.sub, b.kind === "retiro" ? "retiro_efectivo" : "ingreso_efectivo", "cash_session", s.id, { amount: b.amount_cents, reason: b.reason, authorizedBy });
    return reply.code(201).send({ id });
  });

  // Corte final (RN-008): la diferencia exige motivo y queda registrada
  app.post("/api/cash/close", { preHandler: app.authorize("cash.close") }, async (req) => {
    const b = z.object({ counted_cents: z.number().int().min(0), reason: z.string().optional() }).parse(req.body);
    const s = currentSession(req.user.sub);
    if (!s) throw new HttpError(409, "caja_cerrada");
    const summary = sessionSummary(db, s);
    const diff = b.counted_cents - summary.expected_cash_cents;
    if (diff !== 0 && !b.reason) throw new HttpError(400, "motivo_requerido", "Hay diferencia de caja: indica el motivo");
    db.prepare(
      "UPDATE cash_sessions SET status='cerrada', closed_at=?, expected_cents=?, counted_cents=?, difference_cents=?, difference_reason=? WHERE id=?",
    ).run(Date.now(), summary.expected_cash_cents, b.counted_cents, diff, b.reason ?? null, s.id);
    audit(db, req.user.sub, "cerrar_caja", "cash_session", s.id, { expected: summary.expected_cash_cents, counted: b.counted_cents, diff, reason: b.reason });
    if (diff !== 0) hub.emit({ type: "cash.difference", sessionId: s.id, difference_cents: diff });
    return { ok: true, difference_cents: diff, summary };
  });

  app.get("/api/cash/sessions", { preHandler: app.authorize("reports.view") }, async () =>
    db.prepare("SELECT cs.*, u.name AS user FROM cash_sessions cs JOIN users u ON u.id=cs.user_id ORDER BY opened_at DESC LIMIT 100").all(),
  );

  // ---------- Cobro (HU-011, HU-012, RN-010) ----------
  // Un pago puede cubrir toda la cuenta o solo una parte (partes iguales, un asiento). La cuenta se cierra al saldar.
  const payBody = z.object({
    idempotencyKey: z.string().min(8),
    /** Cuánto de la cuenta cubre este pago. Por omisión, el saldo completo. */
    cover_cents: z.number().int().min(1).optional(),
    /** Asiento que se está pagando (para saber qué asientos ya pagaron). */
    seat: z.number().int().min(1).max(20).optional(),
    lines: z.array(z.object({ method: z.enum(METHODS), amount_cents: z.number().int().min(1), reference: z.string().optional() })).min(1),
    tip_cents: z.number().int().min(0).default(0),
    tip_method: z.enum(METHODS).default("efectivo"),
  });

  app.post("/api/accounts/:id/payments", { preHandler: app.authorize("payment.take") }, async (req, reply) => {
    const { id: accountId } = z.object({ id: z.string() }).parse(req.params);
    const b = payBody.parse(req.body);

    // Idempotencia: la misma clave nunca cobra dos veces
    const dup = db.prepare("SELECT * FROM payments WHERE idempotency_key=?").get(b.idempotencyKey) as { id: string; account_id: string; change_cents: number } | undefined;
    if (dup) return reply.code(200).send({ id: dup.id, change_cents: dup.change_cents, duplicate: true });

    const session = currentSession(req.user.sub);
    if (!session) throw new HttpError(409, "caja_cerrada", "Abre caja antes de cobrar");
    const account = db.prepare("SELECT * FROM accounts WHERE id=?").get(accountId) as { id: string; table_id: string | null; status: string } | undefined;
    if (!account) throw new HttpError(404, "no_encontrado");
    if (account.status === "cerrada") throw new HttpError(409, "cuenta_cerrada");

    const total = accountTotal(db, accountId);
    if (total <= 0) throw new HttpError(409, "cuenta_vacia");
    const balance = accountBalance(db, accountId);
    const cover = b.cover_cents ?? balance;
    if (cover > balance) throw new HttpError(400, "excede_saldo", `El saldo pendiente es ${balance} centavos`);

    const paid = b.lines.reduce((s, l) => s + l.amount_cents, 0);
    const excess = paid - cover;
    if (excess < 0) throw new HttpError(400, "pago_insuficiente", `Faltan ${cover - paid} centavos`);
    const cashGiven = b.lines.filter((l) => l.method === "efectivo").reduce((s, l) => s + l.amount_cents, 0);
    if (excess > cashGiven) throw new HttpError(400, "pago_excedido", "Solo el efectivo puede dar cambio");

    // Tarjetas de regalo: deben existir, estar activas y tener saldo para cada renglón
    const gifts = b.lines.filter((l) => l.method === "regalo");
    const cards = new Map<string, { id: string; balance_cents: number; status: string }>();
    for (const g of gifts) {
      const code = (g.reference ?? "").trim().toUpperCase();
      if (!code) throw new HttpError(400, "tarjeta_requerida", "Indica el código de la tarjeta de regalo");
      const card = db.prepare("SELECT id, balance_cents, status FROM gift_cards WHERE code=?").get(code) as { id: string; balance_cents: number; status: string } | undefined;
      if (!card) throw new HttpError(404, "tarjeta_no_encontrada", `La tarjeta ${code} no existe`);
      if (card.status !== "activa") throw new HttpError(409, "tarjeta_inactiva", `La tarjeta ${code} está ${card.status}`);
      const already = gifts.filter((x) => (x.reference ?? "").trim().toUpperCase() === code).reduce((s, x) => s + x.amount_cents, 0);
      if (already > card.balance_cents) throw new HttpError(400, "saldo_insuficiente", `La tarjeta ${code} solo tiene ${card.balance_cents} centavos`);
      cards.set(code, card);
    }

    const paymentId = newId();
    const closes = cover === balance;
    db.transaction(() => {
      db.prepare(
        "INSERT INTO payments (id,account_id,session_id,idempotency_key,user_id,total_cents,tip_cents,tip_method,change_cents,created_at,seat) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      ).run(paymentId, accountId, session.id, b.idempotencyKey, req.user.sub, cover, b.tip_cents, b.tip_cents ? b.tip_method : null, excess, Date.now(), b.seat ?? null);
      // El cambio se descuenta de la primera línea de efectivo para que cuadre la caja
      let toRemove = excess;
      for (const l of b.lines) {
        let amount = l.amount_cents;
        if (l.method === "efectivo" && toRemove > 0) {
          const cut = Math.min(toRemove, amount);
          amount -= cut;
          toRemove -= cut;
        }
        if (amount > 0) db.prepare("INSERT INTO payment_lines (id,payment_id,method,amount_cents,reference) VALUES (?,?,?,?,?)").run(newId(), paymentId, l.method, amount, l.method === "regalo" ? (l.reference ?? "").trim().toUpperCase() : l.reference ?? null);
      }
      for (const g of gifts) {
        const card = cards.get((g.reference ?? "").trim().toUpperCase())!;
        const left = (db.prepare("SELECT balance_cents FROM gift_cards WHERE id=?").get(card.id) as { balance_cents: number }).balance_cents - g.amount_cents;
        if (left < 0) throw new HttpError(400, "saldo_insuficiente");
        db.prepare("UPDATE gift_cards SET balance_cents=?, status=? WHERE id=?").run(left, left === 0 ? "agotada" : "activa", card.id);
        db.prepare("INSERT INTO gift_card_movements (id,card_id,kind,amount_cents,ref,user_id,created_at) VALUES (?,?,?,?,?,?,?)").run(newId(), card.id, "canje", -g.amount_cents, paymentId, req.user.sub, Date.now());
      }
      if (closes) {
        db.prepare("UPDATE accounts SET status='cerrada', closed_at=? WHERE id=?").run(Date.now(), accountId);
        refreshTable(db, account.table_id);
      }
    })();

    const printer = db.prepare("SELECT id, paper_width FROM printers WHERE kind='caja' AND active=1 ORDER BY rowid LIMIT 1").get() as { id: string; paper_width: number } | undefined;
    if (printer) {
      enqueue(db, {
        kind: "ticket", printerId: printer.id,
        lines: billLines(db, accountId, printer.paper_width, {
          tipCents: b.tip_cents, changeCents: excess,
          payments: b.lines.map((l) => ({ method: l.method, amountCents: l.amount_cents })),
          partial: closes && accountPaid(db, accountId) === cover ? undefined : { coveredCents: cover, balanceCents: balance - cover },
        }),
      });
    }
    audit(db, req.user.sub, closes ? "cobrar" : "cobro_parcial", "account", accountId, { paymentId, cover, total, tip: b.tip_cents, methods: b.lines.map((l) => l.method), seat: b.seat });
    hub.emit({ type: "table.updated", tableId: account.table_id });
    hub.emit({ type: "payment.created", accountId, paymentId, closed: closes });
    return reply.code(201).send({ id: paymentId, total_cents: total, covered_cents: cover, change_cents: excess, balance_cents: balance - cover, closed: closes });
  });

  // Saldo de la cuenta y cuánto le toca a cada asiento (para cobrar por asiento o en partes iguales)
  app.get("/api/accounts/:id/balance", { preHandler: app.authorize() }, async (req) => {
    const { id: accountId } = z.object({ id: z.string() }).parse(req.params);
    const acc = db.prepare("SELECT guests FROM accounts WHERE id=?").get(accountId) as { guests: number } | undefined;
    if (!acc) throw new HttpError(404, "no_encontrado");
    const total = accountTotal(db, accountId);
    const subtotal = accountSubtotal(db, accountId);
    const rows = db.prepare("SELECT seat, SUM(quantity*unit_price_cents) s FROM order_items WHERE account_id=? AND status='activo' GROUP BY seat ORDER BY seat").all(accountId) as { seat: number | null; s: number }[];
    // Reparto proporcional de descuentos, servicio y envío; el último asiento absorbe el redondeo para que la suma sea exacta
    let acc2 = 0;
    const seats = rows.map((r, i) => {
      const share = i === rows.length - 1 ? total - acc2 : Math.round(subtotal ? (r.s * total) / subtotal : 0);
      acc2 += share;
      const paidRow = r.seat !== null ? (db.prepare("SELECT COUNT(*) c FROM payments WHERE account_id=? AND seat=?").get(accountId, r.seat) as { c: number }).c : 0;
      return { seat: r.seat, subtotal_cents: r.s, share_cents: share, paid: paidRow > 0 };
    });
    return {
      total_cents: total, paid_cents: accountPaid(db, accountId), balance_cents: accountBalance(db, accountId), guests: acc.guests,
      payments: (db.prepare("SELECT COUNT(*) c FROM payments WHERE account_id=?").get(accountId) as { c: number }).c,
      seats,
    };
  });
}
