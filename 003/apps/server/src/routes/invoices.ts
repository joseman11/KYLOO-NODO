import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, newId, type Db } from "../db";
import { HttpError, accountPaid, serviceChargeCents } from "../domain";
import { RFC_RE, buildCfdiXml, formaPagoSat, type CfdiEmisor, type CfdiInput } from "../cfdi";

/** Proveedor de timbrado (PAC). Un proveedor real implementa esta interfaz y se pasa a `buildApp`. */
export interface InvoiceProvider {
  name: string;
  /** Marca los documentos como "sin validez fiscal" cuando no hay timbrado real. */
  sandbox: boolean;
  stamp(input: CfdiInput): Promise<{ xml: string; uuid: string | null }>;
  cancel(invoice: { uuid: string | null; id: string }, motivo: string): Promise<void>;
}

/** Proveedor de prueba: genera el CFDI 4.0 sin timbre ni UUID. Nunca simula un timbrado real. */
export const sandboxProvider: InvoiceProvider = {
  name: "prueba",
  sandbox: true,
  async stamp(input) {
    return { xml: buildCfdiXml(input, { sandbox: true }).xml, uuid: null };
  },
  async cancel() {
    /* sin PAC no hay nada que cancelar ante el SAT */
  },
};

const setting = async (db: Db, key: string) => (await db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined)?.value ?? "";

export async function getEmisor(db: Db): Promise<CfdiEmisor | null> {
  const e = { rfc: await setting(db, "fiscal_rfc"), nombre: await setting(db, "fiscal_name"), regimen: await setting(db, "fiscal_regimen"), cp: await setting(db, "fiscal_cp") };
  return e.rfc && e.nombre && e.regimen && e.cp ? e : null;
}

const fiscal = z.object({
  rfc: z.string().regex(RFC_RE, "RFC no válido").transform((s) => s.toUpperCase()),
  razon_social: z.string().min(1),
  regimen_fiscal: z.string().regex(/^\d{3}$/, "Régimen de 3 dígitos"),
  cp: z.string().regex(/^\d{5}$/, "Código postal de 5 dígitos"),
  uso_cfdi: z.string().min(3).max(4),
  email: z.string().email().optional(),
});

/** Facturación electrónica (Fase 3, sec. 52): solicitar, generar, cancelar, reenviar y descargar. */
export async function invoiceRoutes(app: FastifyInstance, opts: { provider: InvoiceProvider }) {
  const { db, hub } = app;
  const { provider } = opts;
  const guard = { preHandler: app.authorize("invoice.manage") };
  const id = z.object({ id: z.string() });

  app.post("/api/accounts/:id/invoice", guard, async (req, reply) => {
    const { id: accountId } = id.parse(req.params);
    const b = z.object({ fiscal, customerId: z.string().nullable().optional() }).parse(req.body);
    const emisor = await getEmisor(db);
    if (!emisor) throw new HttpError(409, "emisor_no_configurado", "Configura los datos fiscales del establecimiento (Ajustes)");

    const account = await db.prepare("SELECT id, status FROM accounts WHERE id=?").get(accountId) as { id: string; status: string } | undefined;
    if (!account) throw new HttpError(404, "no_encontrado");
    if (account.status !== "cerrada") throw new HttpError(409, "cuenta_sin_pagar", "Solo se factura una cuenta ya cobrada");
    if (await db.prepare("SELECT 1 FROM invoices WHERE account_id=? AND status='emitida'").get(accountId)) throw new HttpError(409, "ya_facturada", "La cuenta ya tiene una factura vigente");

    // La cuenta pudo cobrarse en varios pagos (partes iguales, por asiento): se factura el total cobrado
    const paidTotal = await accountPaid(db, accountId);
    if (paidTotal <= 0) throw new HttpError(409, "cuenta_sin_pagar");
    const methods = (await db.prepare("SELECT pl.method FROM payment_lines pl JOIN payments p ON p.id=pl.payment_id WHERE p.account_id=?").all(accountId) as { method: string }[]).map((m) => m.method);

    const items = await db.prepare("SELECT name, quantity, unit_price_cents FROM order_items WHERE account_id=? AND status='activo' ORDER BY rowid").all(accountId) as { name: string; quantity: number; unit_price_cents: number }[];
    const lines = items.map((i) => ({ description: i.name, quantity: i.quantity, unitGrossCents: i.unit_price_cents }));
    const fee = (await db.prepare("SELECT fee_cents FROM delivery_info WHERE account_id=?").get(accountId) as { fee_cents: number } | undefined)?.fee_cents ?? 0;
    if (fee > 0) lines.push({ description: "Servicio de envío", quantity: 1, unitGrossCents: fee });
    const service = await serviceChargeCents(db, accountId);
    if (service > 0) lines.push({ description: "Cargo por servicio", quantity: 1, unitGrossCents: service });

    const folio = ((await db.prepare("SELECT COALESCE(MAX(folio),0) m FROM invoices").get() as { m: number }).m) + 1;
    const input: CfdiInput = {
      emisor,
      receptor: { rfc: b.fiscal.rfc, nombre: b.fiscal.razon_social, cp: b.fiscal.cp, regimen: b.fiscal.regimen_fiscal, usoCfdi: b.fiscal.uso_cfdi },
      serie: "A", folio, fecha: new Date(), formaPago: formaPagoSat(methods), metodoPago: "PUE", lines, totalCents: paidTotal,
    };
    const { totals } = buildCfdiXml(input, { sandbox: provider.sandbox });
    const stamped = await provider.stamp(input);

    const invId = newId();
    await db.prepare(
            `INSERT INTO invoices (id,account_id,customer_id,rfc,razon_social,regimen_fiscal,cp,uso_cfdi,forma_pago,metodo_pago,subtotal_cents,iva_cents,total_cents,provider,uuid,serie,folio,xml,email,issued_at,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            invId, accountId, b.customerId ?? null, b.fiscal.rfc, b.fiscal.razon_social, b.fiscal.regimen_fiscal, b.fiscal.cp, b.fiscal.uso_cfdi, input.formaPago, "PUE",
            totals.subtotalCents - totals.discountCents, totals.ivaCents, totals.totalCents, provider.name, stamped.uuid, "A", folio, stamped.xml, b.fiscal.email ?? null, Date.now(), req.user.sub,
          );
    await audit(db, req.user.sub, "emitir_factura", "invoice", invId, { accountId, rfc: b.fiscal.rfc, total: totals.totalCents, provider: provider.name });
    hub.emit({ type: "invoice.issued", invoiceId: invId, accountId });
    return reply.code(201).send({ id: invId, folio, serie: "A", uuid: stamped.uuid, sandbox: provider.sandbox, total_cents: totals.totalCents });
  });

  app.get("/api/invoices", guard, async (req) => {
    const { accountId } = z.object({ accountId: z.string().optional() }).parse(req.query);
    return db
      .prepare(
        `SELECT id, account_id, rfc, razon_social, total_cents, status, provider, uuid, serie, folio, issued_at, cancel_reason
         FROM invoices ${accountId ? "WHERE account_id=?" : ""} ORDER BY issued_at DESC LIMIT 200`,
      )
      .all(...(accountId ? [accountId] : []));
  });

  const find = async (invId: string) => {
    const inv = await db.prepare("SELECT * FROM invoices WHERE id=?").get(invId) as { id: string; xml: string; status: string; uuid: string | null; serie: string; folio: number; provider: string } | undefined;
    if (!inv) throw new HttpError(404, "no_encontrado");
    return inv;
  };

  app.get("/api/invoices/:id/xml", guard, async (req, reply) => {
    const inv = await find(id.parse(req.params).id);
    return reply.header("content-type", "application/xml; charset=utf-8").header("content-disposition", `attachment; filename="${inv.serie}-${inv.folio}.xml"`).send(inv.xml);
  });

  // Representación imprimible (en el navegador: Imprimir → Guardar como PDF)
  app.get("/api/invoices/:id/html", guard, async (req, reply) => {
    const inv = await db.prepare("SELECT * FROM invoices WHERE id=?").get(id.parse(req.params).id) as Record<string, string | number | null> | undefined;
    if (!inv) throw new HttpError(404, "no_encontrado");
    const emisor = await getEmisor(db);
    const e = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    const m = (c: number) => `$${(c / 100).toFixed(2)}`;
    const items = await db.prepare("SELECT name, quantity, unit_price_cents FROM order_items WHERE account_id=? AND status='activo'").all(inv.account_id as string) as { name: string; quantity: number; unit_price_cents: number }[];
    const html = `<!doctype html><meta charset="utf-8"><title>Factura ${e(inv.serie)}-${e(inv.folio)}</title>
<style>body{font:14px Inter,Arial,sans-serif;margin:32px;color:#000}h1{font-size:22px}table{width:100%;border-collapse:collapse;margin:16px 0}td,th{padding:6px;border-bottom:1px solid #ddd;text-align:left}td.r,th.r{text-align:right}.sandbox{border:2px solid #ff5900;color:#ff5900;padding:8px 12px;font-weight:700;display:inline-block}</style>
<h1>Factura ${e(inv.serie)}-${e(inv.folio)} ${inv.status === "cancelada" ? "(CANCELADA)" : ""}</h1>
${inv.provider === "prueba" ? '<div class="sandbox">PRUEBA — sin validez fiscal (no timbrada)</div>' : `<p>UUID: ${e(inv.uuid)}</p>`}
<p><b>Emisor:</b> ${e(emisor?.nombre)} · ${e(emisor?.rfc)} · Régimen ${e(emisor?.regimen)} · CP ${e(emisor?.cp)}</p>
<p><b>Receptor:</b> ${e(inv.razon_social)} · ${e(inv.rfc)} · Régimen ${e(inv.regimen_fiscal)} · CP ${e(inv.cp)} · Uso ${e(inv.uso_cfdi)}</p>
<p>Fecha: ${new Date(inv.issued_at as number).toLocaleString("es-MX")} · Forma de pago ${e(inv.forma_pago)} · Método ${e(inv.metodo_pago)}</p>
<table><tr><th>Cant.</th><th>Descripción</th><th class="r">Precio c/IVA</th></tr>${items.map((i) => `<tr><td>${i.quantity}</td><td>${e(i.name)}</td><td class="r">${m(i.unit_price_cents)}</td></tr>`).join("")}</table>
<p class="r" style="text-align:right">Subtotal ${m(inv.subtotal_cents as number)} · IVA 16% ${m(inv.iva_cents as number)} · <b>Total ${m(inv.total_cents as number)}</b></p>`;
    return reply.header("content-type", "text/html; charset=utf-8").send(html);
  });

  // Motivos de cancelación del SAT: 01 con relación, 02 errores sin relación, 03 no se llevó a cabo, 04 operación nominativa global
  app.post("/api/invoices/:id/cancel", guard, async (req) => {
    const { id: invId } = id.parse(req.params);
    const b = z.object({ motivo: z.enum(["01", "02", "03", "04"]), note: z.string().optional() }).parse(req.body);
    const inv = await find(invId);
    if (inv.status === "cancelada") throw new HttpError(409, "ya_cancelada");
    await provider.cancel({ id: inv.id, uuid: inv.uuid }, b.motivo);
    await db.prepare("UPDATE invoices SET status='cancelada', cancelled_at=?, cancel_reason=? WHERE id=?").run(Date.now(), `${b.motivo}${b.note ? `: ${b.note}` : ""}`, invId);
    await audit(db, req.user.sub, "cancelar_factura", "invoice", invId, b);
    return { ok: true };
  });

  // Reenvío: sin SMTP integrado, se publica el evento para que lo atienda el sistema de correo conectado por webhook
  app.post("/api/invoices/:id/resend", guard, async (req) => {
    const { id: invId } = id.parse(req.params);
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const inv = await find(invId);
    await db.prepare("UPDATE invoices SET email=? WHERE id=?").run(email, invId);
    await audit(db, req.user.sub, "reenviar_factura", "invoice", invId, { email });
    hub.emit({ type: "invoice.resend", invoiceId: inv.id, email });
    return { ok: true, delivery: "evento" };
  });
}
