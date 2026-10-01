import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../db";

const range = z.object({
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
  format: z.enum(["json", "csv"]).default("json"),
});

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const csvCell = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
const toCsv = (rows: Record<string, unknown>[]) =>
  rows.length ? [Object.keys(rows[0]!).join(","), ...rows.map((r) => Object.values(r).map(csvCell).join(","))].join("\n") : "";

export async function reportRoutes(app: FastifyInstance, opts: { backupDir: string }) {
  const { db } = app;

  app.get("/api/reports/sales", { preHandler: app.authorize("reports.view") }, async (req, reply) => {
    const q = range.parse(req.query);
    const from = q.from ?? startOfToday();
    const to = q.to ?? Date.now() + 1;
    const paidAccounts = "(SELECT account_id FROM payments WHERE created_at>=? AND created_at<?)";

    const totals = await db
          .prepare("SELECT COUNT(DISTINCT account_id) tickets, COALESCE(SUM(total_cents),0) sales_cents, COALESCE(SUM(tip_cents),0) tips_cents FROM payments WHERE created_at>=? AND created_at<?")
          .get(from, to) as { tickets: number; sales_cents: number; tips_cents: number };
    const report = {
      from, to,
      ...totals,
      average_ticket_cents: totals.tickets ? Math.round(totals.sales_cents / totals.tickets) : 0,
      by_hour: await db
              .prepare("SELECT strftime('%H', created_at/1000,'unixepoch','localtime') AS hour, COUNT(DISTINCT account_id) tickets, SUM(total_cents) sales_cents FROM payments WHERE created_at>=? AND created_at<? GROUP BY hour ORDER BY hour")
              .all(from, to),
      by_waiter: await db
              .prepare(
                `SELECT u.name waiter, COUNT(DISTINCT a.id) tickets, SUM(i.quantity*i.unit_price_cents) sales_cents FROM order_items i
           JOIN accounts a ON a.id=i.account_id JOIN users u ON u.id=a.waiter_id
           WHERE i.status='activo' AND a.id IN ${paidAccounts} GROUP BY u.id ORDER BY sales_cents DESC`,
              )
              .all(from, to),
      by_product: await db
              .prepare(
                `SELECT i.name product, SUM(i.quantity) units, SUM(i.quantity*i.unit_price_cents) sales_cents FROM order_items i
           WHERE i.status='activo' AND i.account_id IN ${paidAccounts} GROUP BY i.product_id, i.name ORDER BY units DESC`,
              )
              .all(from, to),
      by_method: await db
              .prepare("SELECT pl.method, SUM(pl.amount_cents) total_cents FROM payment_lines pl JOIN payments p ON p.id=pl.payment_id WHERE p.created_at>=? AND p.created_at<? GROUP BY pl.method")
              .all(from, to),
      cancelled: await db
              .prepare("SELECT COUNT(*) items, COALESCE(SUM(quantity*unit_price_cents),0) total_cents FROM order_items WHERE status='cancelado'")
              .get(),
    };
    if (q.format === "csv") {
      const key = z.enum(["by_hour", "by_waiter", "by_product", "by_method"]).catch("by_product").parse((req.query as { section?: string }).section);
      return reply.header("content-type", "text/csv; charset=utf-8").send("﻿" + toCsv(report[key] as Record<string, unknown>[]));
    }
    return report;
  });

  app.get("/api/dashboard", { preHandler: app.authorize("reports.view") }, async () => {
    const from = startOfToday();
    const sales = await db.prepare("SELECT COUNT(DISTINCT account_id) tickets, COALESCE(SUM(total_cents),0) sales_cents FROM payments WHERE created_at>=?").get(from) as { tickets: number; sales_cents: number };
    const count = async (sql: string, ...p: unknown[]) => (await db.prepare(sql).get(...p) as { c: number }).c;
    return {
      sales_today_cents: sales.sales_cents,
      tickets_today: sales.tickets,
      average_ticket_cents: sales.tickets ? Math.round(sales.sales_cents / sales.tickets) : 0,
      open_accounts: await count("SELECT COUNT(*) c FROM accounts WHERE status!='cerrada'"),
      occupied_tables: await count("SELECT COUNT(*) c FROM tables_ WHERE status!='disponible'"),
      pending_tickets: await count("SELECT COUNT(*) c FROM production_tickets WHERE status IN ('pendiente','recibido','preparando')"),
      active_waiters: await count("SELECT COUNT(DISTINCT waiter_id) c FROM accounts WHERE status!='cerrada'"),
      open_cash_sessions: await count("SELECT COUNT(*) c FROM cash_sessions WHERE status='abierta'"),
      print_errors: await count("SELECT COUNT(*) c FROM print_jobs WHERE status='error'"),
      unavailable_products: await count("SELECT COUNT(*) c FROM products WHERE availability!='disponible'"),
    };
  });

  // ---------- Backups (sec. 71) ----------
  app.post("/api/backups", { preHandler: app.authorize("user.manage") }, async (req) => {
    const file = await createBackup(app.db, opts.backupDir);
    await audit(db, req.user.sub, "backup_manual", "sistema", undefined, { file });
    return { file };
  });

  app.get("/api/backups", { preHandler: app.authorize("user.manage") }, async () => listBackups(opts.backupDir));
}

import type { Db } from "../db";

export async function createBackup(db: Db, dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const name = `003-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`;
  await db.backup(join(dir, name));
  // Conserva solo los 14 más recientes
  for (const old of listBackups(dir).slice(14)) rmSync(join(dir, old.file), { force: true });
  return name;
}

export function listBackups(dir: string) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".sqlite"))
      .map((f) => ({ file: f, size: statSync(join(dir, f)).size, created_at: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.created_at - a.created_at);
  } catch {
    return [];
  }
}
