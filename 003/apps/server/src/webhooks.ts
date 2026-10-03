import { createHmac } from "node:crypto";
import { newId, type Db } from "./db";
import type { Hub, HubEvent } from "./hub";

/** Eventos que se pueden enviar a sistemas externos (web, WhatsApp, apps de delivery, ERP…). */
export const WEBHOOK_EVENTS = [
  "order.created",
  "order.updated",
  "ticket.updated",
  "delivery.updated",
  "payment.created",
  "inventory.alert",
  "waiter.called",
  "invoice.issued",
  "invoice.resend",
] as const;

const MAX_ATTEMPTS = 6;

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export const sign = (secret: string, body: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

/** Encola una entrega por cada endpoint suscrito al evento. No hace nada si no hay endpoints. */
export async function queueWebhooks(db: Db, e: HubEvent): Promise<void> {
  if (!(WEBHOOK_EVENTS as readonly string[]).includes(e.type)) return;
  const endpoints = (await db
    .prepare("SELECT id, events FROM webhook_endpoints WHERE active=1")
    .all()) as { id: string; events: string }[];
  if (endpoints.length === 0) return;
  const { type, ...data } = e;
  const body = JSON.stringify({ event: type, data, ts: Date.now() });
  const now = Date.now();
  for (const ep of endpoints) {
    if (ep.events !== "*" && !ep.events.split(",").includes(type)) continue;
    await db
      .prepare(
        "INSERT INTO webhook_deliveries (id,endpoint_id,event,payload,next_attempt_at,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(newId(), ep.id, type, body, now, now);
  }
}

export function connectWebhooks(db: Db, hub: Hub): () => void {
  return hub.subscribe((e) => queueWebhooks(db, e));
}

/** Entrega pendientes con reintentos exponenciales; tras 6 intentos queda en error (consultable y reintentable). */
export async function processWebhooks(
  db: Db,
  fetchFn: FetchLike,
  now = Date.now(),
): Promise<number> {
  const due = (await db
    .prepare(
      `SELECT d.*, e.url, e.secret FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id
       WHERE d.status='pendiente' AND d.next_attempt_at<=? AND e.active=1 ORDER BY d.created_at LIMIT 20`,
    )
    .all(now)) as {
    id: string;
    event: string;
    payload: string;
    attempts: number;
    url: string;
    secret: string;
  }[];
  let sent = 0;
  for (const d of due) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 5000);
      const res = await fetchFn(d.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-003-event": d.event,
          "x-003-delivery": d.id,
          "x-003-signature": sign(d.secret, d.payload),
        },
        body: d.payload,
        signal: ctl.signal,
      }).finally(() => clearTimeout(timer));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await db
        .prepare(
          "UPDATE webhook_deliveries SET status='enviado', attempts=attempts+1, last_error=NULL WHERE id=?",
        )
        .run(d.id);
      sent++;
    } catch (err) {
      const attempts = d.attempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      if (attempts >= MAX_ATTEMPTS)
        await db
          .prepare(
            "UPDATE webhook_deliveries SET status='error', attempts=?, last_error=? WHERE id=?",
          )
          .run(attempts, message, d.id);
      else
        await db
          .prepare(
            "UPDATE webhook_deliveries SET attempts=?, last_error=?, next_attempt_at=? WHERE id=?",
          )
          .run(attempts, message, now + Math.min(300_000, 2000 * 2 ** attempts), d.id);
    }
  }
  return sent;
}

export function startWebhookWorker(db: Db, fetchFn: FetchLike, intervalMs = 2000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processWebhooks(db, fetchFn);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
