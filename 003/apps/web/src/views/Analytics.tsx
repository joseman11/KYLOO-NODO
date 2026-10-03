import { useState } from "react";
import { api, money, useLive } from "../api";
import { PagedRows, SubTabs } from "../fit";

interface Overview {
  tickets: number;
  sales_cents: number;
  tips_cents: number;
  discounts_cents: number;
  average_ticket_cents: number;
  items_per_order: number;
  tables_served: number;
  table_rotation: number;
  avg_attention_minutes: number | null;
  waste_cost_cents: number;
  cancellations: { items: number; total_cents: number; after_production: number };
  change_sales_pct: number | null;
  change_tickets_pct: number | null;
  by_hour: { hour: number; tickets: number; sales_cents: number }[];
  by_weekday: { weekday: number; tickets: number; sales_cents: number }[];
}
interface Abc {
  product: string;
  units: number;
  sales_cents: number;
  share_pct: number;
  class: "A" | "B" | "C";
}
interface Prep {
  station: string;
  tickets: number;
  avg_minutes: number;
  max_minutes: number;
  late: number;
}
interface Forecast {
  date: string;
  weekday: number;
  samples: number;
  expected_sales_cents: number | null;
  expected_tickets: number | null;
  peak_hour: number | null;
}

const DAY = 86_400_000;
const WEEKDAYS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
type Tab = "resumen" | "abc" | "tiempos" | "pronostico";
type Span = "hoy" | "7" | "30";

const startOfToday = () => new Date().setHours(0, 0, 0, 0);
const fromFor = (s: Span) =>
  s === "hoy" ? startOfToday() : startOfToday() - (Number(s) - 1) * DAY;
const delta = (p: number | null) =>
  p === null ? "sin periodo previo" : `${p > 0 ? "+" : ""}${p}% vs. periodo anterior`;

/** Analítica avanzada: métricas operativas, ABC de productos, tiempos por estación y pronóstico. */
export function Analytics() {
  const [tab, setTab] = useState<Tab>("resumen");
  const [span, setSpan] = useState<Span>("7");
  const q = `from=${fromFor(span)}`;
  const overview = useLive(
    () => api<Overview>(`/api/analytics/overview?${q}`),
    ["payment.created"],
    [span],
  );
  const abc = useLive(() => api<Abc[]>(`/api/analytics/abc?${q}`), ["payment.created"], [span]);
  const prep = useLive(
    () => api<Prep[]>(`/api/analytics/prep-times?${q}`),
    ["ticket.updated"],
    [span],
  );
  const forecast = useLive(() => api<Forecast[]>("/api/analytics/forecast?weeks=8"), [], []);
  const o = overview.data;

  return (
    <div className="view">
      <div className="row spread" style={{ flex: "none" }}>
        <SubTabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "resumen", label: "Resumen" },
            { id: "abc", label: "Productos ABC" },
            { id: "tiempos", label: "Tiempos de cocina" },
            { id: "pronostico", label: "Pronóstico" },
          ]}
        />
        {tab !== "pronostico" && (
          <SubTabs
            value={span}
            onChange={setSpan}
            tabs={[
              { id: "hoy", label: "Hoy" },
              { id: "7", label: "7 días" },
              { id: "30", label: "30 días" },
            ]}
          />
        )}
      </div>

      {tab === "resumen" && o && (
        <>
          <div className="stats" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
            <Stat label="Ventas" value={money(o.sales_cents)} hint={delta(o.change_sales_pct)} />
            <Stat label="Tickets" value={String(o.tickets)} hint={delta(o.change_tickets_pct)} />
            <Stat label="Ticket promedio" value={money(o.average_ticket_cents)} />
            <Stat label="Productos por comanda" value={String(o.items_per_order)} />
            <Stat label="Propinas" value={money(o.tips_cents)} />
            <Stat
              label="Mesas atendidas"
              value={String(o.tables_served)}
              hint={`rotación ${o.table_rotation}/día`}
            />
            <Stat
              label="Atención promedio"
              value={o.avg_attention_minutes === null ? "—" : `${o.avg_attention_minutes} min`}
            />
            <Stat
              label="Cancelaciones"
              value={String(o.cancellations.items)}
              hint={`${money(o.cancellations.total_cents)} · ${o.cancellations.after_production} en producción`}
            />
            <Stat label="Descuentos" value={money(o.discounts_cents)} />
            <Stat label="Mermas" value={money(o.waste_cost_cents)} />
          </div>
          <section className="card fillcard">
            <h3>Ventas por hora</h3>
            <HourChart rows={o.by_hour} />
          </section>
        </>
      )}

      {tab === "abc" && (
        <section className="card fillcard">
          <p className="small">
            A: productos que suman el 80 % de la venta · B: hasta 95 % · C: el resto (candidatos a
            revisar del menú).
          </p>
          <PagedRows
            items={abc.data ?? []}
            rowH={44}
            empty={<p className="muted">Sin ventas en el periodo</p>}
            head={
              <tr>
                <th>Clase</th>
                <th>Producto</th>
                <th className="r">Unidades</th>
                <th className="r">Ventas</th>
                <th className="r">% venta</th>
              </tr>
            }
            row={(r) => (
              <>
                <td>
                  <span className={`tag ${r.class === "A" ? "ember" : ""}`}>{r.class}</span>
                </td>
                <td>{r.product}</td>
                <td className="r num">{r.units}</td>
                <td className="r num">{money(r.sales_cents)}</td>
                <td className="r num">{r.share_pct}%</td>
              </>
            )}
          />
        </section>
      )}

      {tab === "tiempos" && (
        <section className="card fillcard">
          <p className="small">
            Minutos desde que la comanda llega a la estación hasta que se marca lista. Retraso: más
            de 15 min.
          </p>
          <PagedRows
            items={prep.data ?? []}
            rowH={48}
            empty={<p className="muted">Aún no hay comandas terminadas</p>}
            head={
              <tr>
                <th>Estación</th>
                <th className="r">Comandas</th>
                <th className="r">Promedio</th>
                <th className="r">Máximo</th>
                <th className="r">Retrasadas</th>
              </tr>
            }
            row={(r) => (
              <>
                <td>{r.station}</td>
                <td className="r num">{r.tickets}</td>
                <td className="r num">{r.avg_minutes} min</td>
                <td className="r num">{r.max_minutes} min</td>
                <td className={`r num ${r.late ? "err" : ""}`}>{r.late}</td>
              </>
            )}
          />
        </section>
      )}

      {tab === "pronostico" && (
        <section className="card fillcard">
          <p className="small">
            Promedio del mismo día de la semana en las últimas 8 semanas. Sirve para planear compras
            y turnos; no es una garantía.
          </p>
          <PagedRows
            items={forecast.data ?? []}
            rowH={48}
            head={
              <tr>
                <th>Día</th>
                <th className="r">Ventas esperadas</th>
                <th className="r">Tickets</th>
                <th className="r">Hora pico</th>
                <th className="r">Semanas con datos</th>
              </tr>
            }
            row={(r) => (
              <>
                <td>
                  {WEEKDAYS[r.weekday]} <span className="small">{r.date.slice(5)}</span>
                </td>
                <td className="r num">
                  {r.expected_sales_cents === null ? "—" : money(r.expected_sales_cents)}
                </td>
                <td className="r num">{r.expected_tickets ?? "—"}</td>
                <td className="r num">{r.peak_hour === null ? "—" : `${r.peak_hour}:00`}</td>
                <td className="r num">{r.samples}</td>
              </>
            )}
          />
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card stat" style={{ padding: 12 }}>
      <div className="small">{label}</div>
      <div className="v num" style={{ fontSize: 24 }}>
        {value}
      </div>
      {hint && <div className="small ellipsis">{hint}</div>}
    </div>
  );
}

/** $55.5k / $905: cifra corta para que las etiquetas no se encimen */
const compact = (cents: number) => {
  const p = cents / 100;
  return p >= 1000 ? `${(p / 1000).toFixed(p >= 10000 ? 0 : 1)}k` : `${Math.round(p)}`;
};

/** Barras por hora hechas con CSS: llenan el espacio disponible y la hora pico resalta con el acento. */
function HourChart({ rows }: { rows: { hour: number; tickets: number; sales_cents: number }[] }) {
  if (rows.length === 0) return <p className="muted">Sin ventas en el periodo</p>;
  const hours = Array.from(
    { length: 24 },
    (_, h) => rows.find((r) => r.hour === h) ?? { hour: h, tickets: 0, sales_cents: 0 },
  );
  const first = Math.max(0, Math.min(...rows.map((r) => r.hour)) - 1);
  const last = Math.min(23, Math.max(...rows.map((r) => r.hour)) + 1);
  const shown = hours.slice(first, last + 1);
  const max = Math.max(...shown.map((r) => r.sales_cents), 1);
  const peak = shown.reduce((a, b) => (b.sales_cents > a.sales_cents ? b : a));
  return (
    <div
      style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "stretch", gap: 6 }}
      role="img"
      aria-label="Ventas por hora"
    >
      {shown.map((r) => (
        <div
          key={r.hour}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: 4,
          }}
          title={`${r.hour}:00 · ${r.tickets} tickets · ${money(r.sales_cents)}`}
        >
          <span className="small num" style={{ fontSize: 11 }}>
            {r.sales_cents ? compact(r.sales_cents) : ""}
          </span>
          <div
            style={{
              width: "100%",
              height: `${Math.round((r.sales_cents / max) * 100)}%`,
              minHeight: r.sales_cents ? 4 : 0,
              background:
                r === peak
                  ? "linear-gradient(180deg, var(--color-ember-2), var(--color-ember))"
                  : "linear-gradient(180deg, #3a4558, #1b2230)",
              borderRadius: "10px 10px 4px 4px",
              maxHeight: "calc(100% - 40px)",
            }}
          />
          <span className="small num">{r.hour}</span>
        </div>
      ))}
    </div>
  );
}
