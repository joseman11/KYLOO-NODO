import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../db";
import { HttpError } from "../domain";
import { enqueue, processQueue } from "../printing/queue";
import { renderTest } from "../printing/render";
import { BOLD } from "../printing/markup";
import type { PrinterTransport } from "../printing/transport";
import type { Hub } from "../hub";

interface PrinterRow {
  id: string;
  name: string;
  host: string | null;
  port: number;
  paper_width: number;
}

export async function printingRoutes(app: FastifyInstance, opts: { hub: Hub; transport: PrinterTransport }) {
  const { db } = app;
  const { hub, transport } = opts;
  const id = z.object({ id: z.string() });

  // Estado de conexión de todas las impresoras activas (HU-020)
  app.get("/api/printers/status", { preHandler: app.authorize() }, async () => {
    const printers = await db.prepare("SELECT * FROM printers WHERE active=1").all() as PrinterRow[];
    return Promise.all(
      printers.map(async (p) => ({ id: p.id, name: p.name, online: await transport.ping({ host: p.host, port: p.port }) })),
    );
  });

  // Imprimir prueba (HU-019): se envía directo para dar el resultado al instante
  app.post("/api/printers/:id/test", { preHandler: app.authorize("printer.manage") }, async (req) => {
    const { id: printerId } = id.parse(req.params);
    const p = await db.prepare("SELECT * FROM printers WHERE id=?").get(printerId) as PrinterRow | undefined;
    if (!p) throw new HttpError(404, "no_encontrado");
    const jobId = await enqueue(db, { kind: "prueba", printerId, lines: renderTest(p.name, p.paper_width) });
    await processQueue(db, transport, hub);
    const job = await db.prepare("SELECT status, last_error FROM print_jobs WHERE id=?").get(jobId) as { status: string; last_error: string | null };
    await audit(db, req.user.sub, "imprimir_prueba", "printer", printerId, { status: job.status });
    return { ok: job.status === "impreso", status: job.status, error: job.last_error };
  });

  app.get("/api/print-jobs", { preHandler: app.authorize() }, async (req) => {
    const { status } = z.object({ status: z.enum(["pendiente", "impreso", "error"]).optional() }).parse(req.query);
    return db
      .prepare(`SELECT id,kind,printer_id,status,attempts,last_error,created_at,printed_at FROM print_jobs ${status ? "WHERE status=?" : ""} ORDER BY created_at DESC LIMIT 100`)
      .all(...(status ? [status] : []));
  });

  // Reintentar / cambiar impresora de un trabajo con error (sec. 60)
  app.post("/api/print-jobs/:id/retry", { preHandler: app.authorize("comanda.reprint") }, async (req) => {
    const { id: jobId } = id.parse(req.params);
    const { printerId } = z.object({ printerId: z.string().optional() }).parse(req.body ?? {});
    const job = await db.prepare("SELECT * FROM print_jobs WHERE id=?").get(jobId) as { id: string; status: string } | undefined;
    if (!job) throw new HttpError(404, "no_encontrado");
    if (job.status === "impreso") throw new HttpError(409, "ya_impreso");
    if (printerId && !await db.prepare("SELECT 1 FROM printers WHERE id=?").get(printerId)) throw new HttpError(404, "impresora_no_encontrada");
    await db.prepare("UPDATE print_jobs SET status='pendiente', attempts=0, next_attempt_at=?, printer_id=COALESCE(?, printer_id) WHERE id=?").run(Date.now(), printerId ?? null, jobId);
    await audit(db, req.user.sub, "reintentar_impresion", "print_job", jobId, { printerId });
    return { ok: true };
  });

  // Reimpresión de comanda con motivo y auditoría (sec. 14)
  app.post("/api/tickets/:id/reprint", { preHandler: app.authorize("comanda.reprint") }, async (req) => {
    const { id: ticketId } = id.parse(req.params);
    const { reason } = z.object({ reason: z.string().min(2) }).parse(req.body);
    const original = await db
          .prepare("SELECT * FROM print_jobs WHERE ticket_id=? AND kind IN ('comanda','adicion') ORDER BY created_at LIMIT 1")
          .get(ticketId) as { printer_id: string; fallback_printer_id: string | null; content: string; kind: string } | undefined;
    if (!original) throw new HttpError(404, "sin_impresion_previa");
    const lines = [`${BOLD}*** REIMPRESION ***`, ...(JSON.parse(original.content) as string[])];
    const jobId = await enqueue(db, { kind: original.kind, ticketId, printerId: original.printer_id, fallbackPrinterId: original.fallback_printer_id, lines });
    await audit(db, req.user.sub, "reimprimir_comanda", "ticket", ticketId, { reason, jobId, printerId: original.printer_id });
    return { ok: true, jobId };
  });
}
