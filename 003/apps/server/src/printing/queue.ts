import { newId, type Db } from "../db";
import type { Hub } from "../hub";
import { toEscpos } from "./escpos";
import type { PrinterTransport } from "./transport";

/** Intentos sobre la impresora principal antes de pasar a la secundaria (sec. 60). */
const PRIMARY_ATTEMPTS = 2;
const MAX_ATTEMPTS = 5;

interface JobRow {
  id: string;
  kind: string;
  printer_id: string;
  fallback_printer_id: string | null;
  content: string;
  attempts: number;
}

interface PrinterRow {
  id: string;
  name: string;
  host: string | null;
  port: number;
  copies: number;
  auto_cut: number;
  active: number;
}

export function enqueue(
  db: Db,
  job: { kind: string; ticketId?: string; printerId: string; fallbackPrinterId?: string | null; lines: string[] },
): string {
  const id = newId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO print_jobs (id,kind,ticket_id,printer_id,fallback_printer_id,content,next_attempt_at,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, job.kind, job.ticketId ?? null, job.printerId, job.fallbackPrinterId ?? null, JSON.stringify(job.lines), now, now);
  return id;
}

/** Procesa los trabajos pendientes cuyo reintento ya venció. Nunca elimina un trabajo fallido (RN-012). */
export async function processQueue(db: Db, transport: PrinterTransport, hub: Hub, now = Date.now()): Promise<number> {
  const due = db
    .prepare("SELECT * FROM print_jobs WHERE status='pendiente' AND next_attempt_at<=? ORDER BY created_at LIMIT 20")
    .all(now) as JobRow[];
  let printed = 0;

  for (const job of due) {
    const printer = db.prepare("SELECT * FROM printers WHERE id=?").get(job.printer_id) as PrinterRow | undefined;
    try {
      if (!printer || !printer.active) throw new Error("Impresora inactiva o inexistente");
      const lines = JSON.parse(job.content) as string[];
      const data = toEscpos(lines, { cut: !!printer.auto_cut });
      for (let c = 0; c < printer.copies; c++) await transport.send({ host: printer.host, port: printer.port }, data);
      db.prepare("UPDATE print_jobs SET status='impreso', printed_at=?, last_error=NULL WHERE id=?").run(Date.now(), job.id);
      hub.emit({ type: "print.ok", jobId: job.id });
      printed++;
    } catch (e) {
      const attempts = job.attempts + 1;
      const message = e instanceof Error ? e.message : String(e);
      if (attempts >= PRIMARY_ATTEMPTS && job.fallback_printer_id) {
        // Redirige a la impresora secundaria y reinicia el conteo
        db.prepare(
          "UPDATE print_jobs SET printer_id=?, fallback_printer_id=NULL, attempts=0, last_error=?, next_attempt_at=? WHERE id=?",
        ).run(job.fallback_printer_id, message, now, job.id);
        hub.emit({ type: "print.failover", jobId: job.id, from: job.printer_id, to: job.fallback_printer_id });
      } else if (attempts >= MAX_ATTEMPTS) {
        db.prepare("UPDATE print_jobs SET status='error', attempts=?, last_error=? WHERE id=?").run(attempts, message, job.id);
        hub.emit({ type: "print.error", jobId: job.id, printerId: job.printer_id, message });
      } else {
        const backoff = Math.min(30_000, 1000 * 2 ** attempts);
        db.prepare("UPDATE print_jobs SET attempts=?, last_error=?, next_attempt_at=? WHERE id=?").run(attempts, message, now + backoff, job.id);
      }
    }
  }
  return printed;
}

export function startPrintWorker(db: Db, transport: PrinterTransport, hub: Hub, intervalMs = 1000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processQueue(db, transport, hub);
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
