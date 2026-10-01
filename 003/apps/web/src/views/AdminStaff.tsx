import { useState } from "react";
import { api, can, money, useLive } from "../api";
import { PagedRows, SubTabs } from "../fit";

const DAY = 86_400_000;
type Span = "hoy" | "7" | "30";
const startOfToday = () => new Date().setHours(0, 0, 0, 0);
const fromFor = (s: Span) => (s === "hoy" ? startOfToday() : startOfToday() - (Number(s) - 1) * DAY);
const hhmm = (h: number) => `${Math.floor(h)} h ${String(Math.round((h % 1) * 60)).padStart(2, "0")} min`;
const POLICY: Record<string, string> = { individual: "cada mesero conserva lo suyo", pool: "fondo común" };

interface ClockRow { id: string; name: string; role: string; hours: number; shifts: number; on_shift: boolean; }
interface TipReport {
  policy: string; support_pct: number; total_cents: number; unassigned_cents: number;
  payouts: { user_id: string; name: string; role: string; hours: number; own_tips_cents: number; amount_cents: number }[];
}

/** Personal: horas del checador y reparto de propinas del periodo. */
export function StaffPanel() {
  const [span, setSpan] = useState<Span>("hoy");
  const q = `from=${fromFor(span)}&to=${Date.now() + 60_000}`;
  const clock = useLive(() => api<ClockRow[]>(`/api/clock/report?${q}`), ["staff.updated"], [span]);
  const tips = useLive(() => api<TipReport>(`/api/tips/report?${q}`), ["payment.created", "staff.updated"], [span]);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="view">
      <div className="row spread" style={{ flex: "none" }}>
        <span className="small">Las propinas se reparten con la política de Configuración → Ajustes → Propinas.</span>
        <SubTabs value={span} onChange={setSpan} tabs={[{ id: "hoy", label: "Hoy" }, { id: "7", label: "7 días" }, { id: "30", label: "30 días" }]} />
      </div>
      {err && <p className="err" style={{ flex: "none" }}>{err}</p>}
      <div className="split">
        <section className="card fillcard">
          <h3>Horas trabajadas</h3>
          <PagedRows items={clock.data ?? []} rowH={48} empty={<p className="muted">Nadie ha registrado entrada en este periodo</p>}
            head={<tr><th>Persona</th><th>Rol</th><th className="r">Horas</th><th /></tr>}
            row={(r) => (
              <>
                <td>{r.name}{r.on_shift && <span className="tag ember" style={{ marginLeft: 6 }}>en turno</span>}</td>
                <td className="small">{r.role}</td>
                <td className="r num">{hhmm(r.hours)}</td>
                <td className="r">{r.on_shift && can("user.manage") && <button className="btn ghost sm" onClick={() => api(`/api/clock/${r.id}/out`, { body: {} }).then(() => clock.reload(), (e) => setErr((e as Error).message))}>Cerrar turno</button>}</td>
              </>
            )} />
        </section>
        <section className="card fillcard">
          <div className="row spread"><h3>Reparto de propinas</h3>{tips.data && <span className="small">{POLICY[tips.data.policy]}</span>}</div>
          {tips.data && <div className="row spread" style={{ flex: "none" }}><span className="small">Total del periodo</span><strong className="num">{money(tips.data.total_cents)}</strong></div>}
          <PagedRows items={tips.data?.payouts ?? []} rowH={48} empty={<p className="muted">Sin propinas en este periodo</p>}
            head={<tr><th>Persona</th><th className="r">Horas</th><th className="r">Propias</th><th className="r">Le toca</th></tr>}
            row={(p) => <><td>{p.name}<div className="small">{p.role}</div></td><td className="r num">{p.hours ? hhmm(p.hours) : "—"}</td><td className="r num">{money(p.own_tips_cents)}</td><td className="r num"><strong>{money(p.amount_cents)}</strong></td></>} />
          {tips.data && tips.data.unassigned_cents !== 0 && <p className="err" style={{ flex: "none" }}>Sin asignar: {money(tips.data.unassigned_cents)}</p>}
        </section>
      </div>
    </div>
  );
}

interface Card { id: string; code: string; initial_cents: number; balance_cents: number; status: string; sold_method: string | null; created_at: number; }

/** Tarjetas de regalo: vendidas, canjeadas y saldo pendiente (lo que el negocio aún debe en consumos). */
export function GiftCardsPanel() {
  const data = useLive(() => api<{ cards: Card[]; sold_cents: number; redeemed_cents: number; outstanding_cents: number }>("/api/gift-cards"), ["payment.created"]);
  const [err, setErr] = useState<string | null>(null);
  const d = data.data;
  return (
    <div className="view">
      {d && (
        <div className="stats" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
          <div className="card stat" style={{ padding: 12 }}><div className="small">Vendidas</div><div className="v num" style={{ fontSize: 24 }}>{money(d.sold_cents)}</div></div>
          <div className="card stat" style={{ padding: 12 }}><div className="small">Canjeadas</div><div className="v num" style={{ fontSize: 24 }}>{money(d.redeemed_cents)}</div></div>
          <div className="card stat" style={{ padding: 12 }}><div className="small">Saldo pendiente</div><div className="v num" style={{ fontSize: 24 }}>{money(d.outstanding_cents)}</div></div>
        </div>
      )}
      {err && <p className="err" style={{ flex: "none" }}>{err}</p>}
      <section className="card fillcard">
        <PagedRows items={d?.cards ?? []} rowH={48} empty={<p className="muted">Aún no se han vendido tarjetas de regalo</p>}
          head={<tr><th>Código</th><th>Estado</th><th className="r">Inicial</th><th className="r">Saldo</th><th /></tr>}
          row={(c) => (
            <>
              <td className="num" style={{ userSelect: "text" }}>{c.code}</td>
              <td><span className={`tag ${c.status === "activa" ? "ember" : ""}`}>{c.status}</span></td>
              <td className="r num">{money(c.initial_cents)}</td><td className="r num">{money(c.balance_cents)}</td>
              <td className="r">{c.status === "activa" && can("refund.authorize") && <button className="btn ghost sm" onClick={() => api(`/api/gift-cards/${c.code}/cancel`, { body: {} }).then(() => data.reload(), (e) => setErr((e as Error).message))}>Cancelar</button>}</td>
            </>
          )} />
      </section>
    </div>
  );
}
