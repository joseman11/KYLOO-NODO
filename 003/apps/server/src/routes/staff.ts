import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, newId, type Db } from "../db";
import { HttpError } from "../domain";
import { distributeTips, type TipPolicy } from "../tips";

const range = z.object({ from: z.coerce.number().optional(), to: z.coerce.number().optional() });
const startOfToday = () => new Date().setHours(0, 0, 0, 0);

const setting = async (db: Db, key: string) => (await db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined)?.value;

/** Horas trabajadas por usuario en el periodo (los turnos abiertos cuentan hasta ahora o hasta el fin del periodo). */
export async function hoursByUser(db: Db, from: number, to: number, now = Date.now()) {
  const rows = await db.prepare("SELECT user_id, clock_in, clock_out FROM time_entries WHERE clock_in<? AND COALESCE(clock_out, ?)>?").all(to, now, from) as { user_id: string; clock_in: number; clock_out: number | null }[];
  const out = new Map<string, { hours: number; shifts: number; open: boolean }>();
  for (const r of rows) {
    const end = Math.min(r.clock_out ?? now, to);
    const start = Math.max(r.clock_in, from);
    const cur = out.get(r.user_id) ?? { hours: 0, shifts: 0, open: false };
    cur.hours += Math.max(0, end - start) / 3_600_000;
    cur.shifts += 1;
    cur.open = cur.open || r.clock_out === null;
    out.set(r.user_id, cur);
  }
  return out;
}

/** Checador de personal y reparto de propinas (Fase 4). */
export async function staffRoutes(app: FastifyInstance) {
  const { db, hub } = app;

  // ---------- Checador ----------
  const openEntry = async (userId: string) => await db.prepare("SELECT id, clock_in FROM time_entries WHERE user_id=? AND clock_out IS NULL").get(userId) as { id: string; clock_in: number } | undefined;

  app.get("/api/clock/status", { preHandler: app.authorize() }, async (req) => {
    const e = await openEntry(req.user.sub);
    return { on_shift: !!e, since: e?.clock_in ?? null };
  });

  app.post("/api/clock/in", { preHandler: app.authorize() }, async (req, reply) => {
    if (await openEntry(req.user.sub)) throw new HttpError(409, "ya_en_turno", "Ya registraste tu entrada");
    const id = newId();
    await db.prepare("INSERT INTO time_entries (id,user_id,clock_in) VALUES (?,?,?)").run(id, req.user.sub, Date.now());
    await audit(db, req.user.sub, "entrada", "turno", id);
    hub.emit({ type: "staff.updated" });
    return reply.code(201).send({ id });
  });

  app.post("/api/clock/out", { preHandler: app.authorize() }, async (req) => {
    const e = await openEntry(req.user.sub);
    if (!e) throw new HttpError(409, "sin_turno", "No tienes una entrada abierta");
    await db.prepare("UPDATE time_entries SET clock_out=? WHERE id=?").run(Date.now(), e.id);
    await audit(db, req.user.sub, "salida", "turno", e.id);
    hub.emit({ type: "staff.updated" });
    return { ok: true, hours: (Date.now() - e.clock_in) / 3_600_000 };
  });

  // Cierre de un turno olvidado (lo hace quien administra usuarios)
  app.post("/api/clock/:userId/out", { preHandler: app.authorize("user.manage") }, async (req) => {
    const { userId } = z.object({ userId: z.string() }).parse(req.params);
    const { at } = z.object({ at: z.number().int().optional() }).parse(req.body ?? {});
    const e = await openEntry(userId);
    if (!e) throw new HttpError(404, "sin_turno");
    const when = Math.max(e.clock_in, at ?? Date.now());
    await db.prepare("UPDATE time_entries SET clock_out=?, note=? WHERE id=?").run(when, "Cerrado por un administrador", e.id);
    await audit(db, req.user.sub, "cerrar_turno", "turno", e.id, { userId });
    hub.emit({ type: "staff.updated" });
    return { ok: true };
  });

  app.get("/api/clock/report", { preHandler: app.authorize("reports.view") }, async (req) => {
    const q = range.parse(req.query);
    const from = q.from ?? startOfToday() - 6 * 86_400_000;
    const to = q.to ?? Date.now() + 1;
    const hours = await hoursByUser(db, from, to);
    const users = await db.prepare("SELECT id, name, role FROM users WHERE active=1 OR id IN (SELECT user_id FROM time_entries) ORDER BY name").all() as { id: string; name: string; role: string }[];
    return users
      .map((u) => ({ ...u, hours: Math.round((hours.get(u.id)?.hours ?? 0) * 100) / 100, shifts: hours.get(u.id)?.shifts ?? 0, on_shift: !!hours.get(u.id)?.open }))
      .filter((u) => u.shifts > 0 || u.on_shift);
  });

  // ---------- Reparto de propinas ----------
  app.get("/api/tips/report", { preHandler: app.authorize("reports.view") }, async (req) => {
    const q = range.parse(req.query);
    const from = q.from ?? startOfToday();
    const to = q.to ?? Date.now() + 1;
    const policy = (await setting(db, "tip_policy") ?? "individual") as TipPolicy;
    let roles: Record<string, number> = { mesero: 60, cocina: 25, bar: 15 };
    try {
      roles = JSON.parse(await setting(db, "tip_roles") ?? "") as Record<string, number>;
    } catch {
      /* se queda el reparto por omisión */
    }
    const supportPct = Number(await setting(db, "tip_support_pct") ?? 0);

    // Propinas por mesero: las de las cuentas que atendió, cobradas en el periodo
    const tips = await db
          .prepare("SELECT a.waiter_id w, SUM(p.tip_cents) t FROM payments p JOIN accounts a ON a.id=p.account_id WHERE p.created_at>=? AND p.created_at<? AND p.tip_cents>0 GROUP BY a.waiter_id")
          .all(from, to) as { w: string; t: number }[];
    const tipsByWaiter = Object.fromEntries(tips.map((t) => [t.w, t.t]));

    const hours = await hoursByUser(db, from, to);
    const users = await db.prepare("SELECT id, name, role FROM users").all() as { id: string; name: string; role: string }[];
    const staff = users.filter((u) => (hours.get(u.id)?.hours ?? 0) > 0).map((u) => ({ id: u.id, role: u.role, hours: hours.get(u.id)!.hours }));

    const result = distributeTips({ policy, roles, supportPct, tipsByWaiter, staff });
    const rows = Object.entries(result.payouts)
      .map(([id, amount]) => {
        const u = users.find((x) => x.id === id);
        return { user_id: id, name: u?.name ?? "?", role: u?.role ?? "?", hours: Math.round((hours.get(id)?.hours ?? 0) * 100) / 100, own_tips_cents: tipsByWaiter[id] ?? 0, amount_cents: amount };
      })
      .sort((a, b) => b.amount_cents - a.amount_cents);
    return { from, to, policy, roles, support_pct: supportPct, total_cents: result.totalCents, unassigned_cents: result.unassignedCents, payouts: rows };
  });
}
