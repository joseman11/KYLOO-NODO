import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, newId } from "../db";
import { HttpError } from "../domain";
import { enqueue } from "../printing/queue";
import { BIG } from "../printing/markup";
import { money, widthFor } from "../printing/render";

// Sin 0/O ni 1/I para que no se confunda el código al dictarlo
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const makeCode = () => {
  const b = randomBytes(8);
  const part = (o: number) => Array.from({ length: 4 }, (_, i) => ALPHABET[b[o + i]! % ALPHABET.length]).join("");
  return `GC-${part(0)}-${part(4)}`;
};

/** Tarjetas de regalo: se venden en caja y se canjean como método de pago (`regalo`). */
export async function giftCardRoutes(app: FastifyInstance) {
  const { db } = app;

  app.post("/api/gift-cards", { preHandler: app.authorize("payment.take") }, async (req, reply) => {
    const b = z.object({ amount_cents: z.number().int().min(1000).max(5_000_000), method: z.enum(["efectivo", "tarjeta", "transferencia"]) }).parse(req.body);
    const session = db.prepare("SELECT id FROM cash_sessions WHERE user_id=? AND status='abierta'").get(req.user.sub) as { id: string } | undefined;
    if (!session) throw new HttpError(409, "caja_cerrada", "Abre caja antes de vender una tarjeta");

    let code = makeCode();
    while (db.prepare("SELECT 1 FROM gift_cards WHERE code=?").get(code)) code = makeCode();
    const cardId = newId();
    const now = Date.now();
    db.transaction(() => {
      db.prepare("INSERT INTO gift_cards (id,code,initial_cents,balance_cents,sold_method,sold_by,created_at) VALUES (?,?,?,?,?,?,?)").run(cardId, code, b.amount_cents, b.amount_cents, b.method, req.user.sub, now);
      db.prepare("INSERT INTO gift_card_movements (id,card_id,kind,amount_cents,user_id,created_at) VALUES (?,?,'venta',?,?,?)").run(newId(), cardId, b.amount_cents, req.user.sub, now);
      // El efectivo de la venta entra a la caja (no es venta del restaurante: es saldo a favor del cliente)
      if (b.method === "efectivo") {
        db.prepare("INSERT INTO cash_movements (id,session_id,kind,amount_cents,reason,user_id,created_at) VALUES (?,?,'ingreso',?,?,?,?)").run(newId(), session.id, b.amount_cents, `Venta tarjeta de regalo ${code}`, req.user.sub, now);
      }
      const printer = db.prepare("SELECT id, paper_width FROM printers WHERE kind='caja' AND active=1 ORDER BY rowid LIMIT 1").get() as { id: string; paper_width: number } | undefined;
      if (printer) {
        const w = widthFor(printer.paper_width);
        enqueue(db, { kind: "tarjeta_regalo", printerId: printer.id, lines: [`${BIG}TARJETA DE REGALO`, "-".repeat(w), `${BIG}${code}`, `Saldo: ${money(b.amount_cents)}`, "-".repeat(w), "Presenta este código para canjearla"] });
      }
    })();
    audit(db, req.user.sub, "vender_tarjeta_regalo", "gift_card", cardId, { amount: b.amount_cents, method: b.method });
    app.hub.emit({ type: "payment.created", giftCard: true });
    return reply.code(201).send({ id: cardId, code, balance_cents: b.amount_cents });
  });

  // Consulta de saldo al cobrar (cualquier usuario con sesión; el código es el secreto)
  app.get("/api/gift-cards/:code", { preHandler: app.authorize() }, async (req) => {
    const { code } = z.object({ code: z.string() }).parse(req.params);
    const c = db.prepare("SELECT code, balance_cents, status FROM gift_cards WHERE code=?").get(code.trim().toUpperCase());
    if (!c) throw new HttpError(404, "tarjeta_no_encontrada", "No existe una tarjeta con ese código");
    return c;
  });

  // Reporte: vendidas, canjeadas y saldo pendiente (pasivo del negocio)
  app.get("/api/gift-cards", { preHandler: app.authorize("reports.view") }, async () => {
    const cards = db.prepare("SELECT id, code, initial_cents, balance_cents, status, sold_method, created_at FROM gift_cards ORDER BY created_at DESC LIMIT 200").all();
    const t = db.prepare("SELECT COALESCE(SUM(initial_cents),0) sold, COALESCE(SUM(balance_cents),0) outstanding FROM gift_cards WHERE status!='cancelada'").get() as { sold: number; outstanding: number };
    return { cards, sold_cents: t.sold, redeemed_cents: t.sold - t.outstanding, outstanding_cents: t.outstanding };
  });

  app.post("/api/gift-cards/:code/cancel", { preHandler: app.authorize("refund.authorize") }, async (req) => {
    const { code } = z.object({ code: z.string() }).parse(req.params);
    const c = db.prepare("SELECT id, balance_cents FROM gift_cards WHERE code=? AND status='activa'").get(code.trim().toUpperCase()) as { id: string; balance_cents: number } | undefined;
    if (!c) throw new HttpError(404, "tarjeta_no_encontrada", "No existe una tarjeta activa con ese código");
    db.prepare("UPDATE gift_cards SET status='cancelada' WHERE id=?").run(c.id);
    db.prepare("INSERT INTO gift_card_movements (id,card_id,kind,amount_cents,user_id,created_at) VALUES (?,?,'cancelacion',?,?,?)").run(newId(), c.id, -c.balance_cents, req.user.sub, Date.now());
    audit(db, req.user.sub, "cancelar_tarjeta_regalo", "gift_card", c.id, { balance: c.balance_cents });
    return { ok: true, balance_cents: c.balance_cents };
  });
}
