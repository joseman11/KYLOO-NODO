import { useState } from "react";
import { api, can, money, useLive } from "../api";
import { PagedRows, SubTabs } from "../fit";
import { InvoiceList } from "./Invoices";
import { GiftCardsPanel, StaffPanel } from "./AdminStaff";

interface Dash {
  sales_today_cents: number;
  tickets_today: number;
  average_ticket_cents: number;
  open_accounts: number;
  occupied_tables: number;
  pending_tickets: number;
  active_waiters: number;
  open_cash_sessions: number;
  print_errors: number;
  unavailable_products: number;
}
interface Sales {
  by_product: { product: string; units: number; sales_cents: number }[];
  by_waiter: { waiter: string; tickets: number; sales_cents: number }[];
  by_method: { method: string; total_cents: number }[];
}
interface PrinterStatus {
  id: string;
  name: string;
  online: boolean;
}
interface Job {
  id: string;
  kind: string;
  printer_id: string;
  status: string;
  attempts: number;
  last_error: string | null;
}
interface Audit {
  id: number;
  ts: number;
  action: string;
  entity: string | null;
  detail: string | null;
}

type Tab = "resumen" | "ventas" | "personal" | "tarjetas" | "facturas" | "impresoras" | "auditoria";

export function Admin() {
  const [tab, setTab] = useState<Tab>("resumen");
  const dash = useLive(
    () => api<Dash>("/api/dashboard"),
    ["payment.created", "order.created", "table.updated", "print.error"],
  );
  const sales = useLive(() => api<Sales>("/api/reports/sales"), ["payment.created"]);
  const printers = useLive(
    () => api<PrinterStatus[]>("/api/printers/status"),
    ["print.error", "print.ok", "print.failover"],
  );
  const jobs = useLive(
    () => api<Job[]>("/api/print-jobs?status=error"),
    ["print.error", "print.ok"],
  );
  const audit = useLive(
    () => api<Audit[]>("/api/audit?limit=200"),
    ["order.created", "payment.created", "table.updated"],
  );
  const [msg, setMsg] = useState<string | null>(null);
  const d = dash.data;

  const test = async (id: string) => {
    const r = await api<{ ok: boolean; error: string | null }>(`/api/printers/${id}/test`, {
      method: "POST",
      body: {},
    });
    setMsg(r.ok ? "Impresión de prueba enviada" : `Falló: ${r.error}`);
    printers.reload();
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: "resumen", label: "Resumen" },
    { id: "ventas", label: "Ventas" },
    { id: "personal", label: "Personal y propinas" },
    { id: "tarjetas", label: "Tarjetas de regalo" },
    ...(can("invoice.manage") ? [{ id: "facturas" as Tab, label: "Facturas" }] : []),
    ...(can("printer.manage")
      ? [
          {
            id: "impresoras" as Tab,
            label: `Impresoras${d?.print_errors ? ` (${d.print_errors})` : ""}`,
          },
        ]
      : []),
    { id: "auditoria", label: "Auditoría" },
  ];

  return (
    <div className="view">
      <div className="row spread" style={{ flex: "none" }}>
        <SubTabs tabs={tabs} value={tab} onChange={setTab} />
        {can("user.manage") && (
          <button
            className="btn sm"
            onClick={() =>
              api("/api/backups", { method: "POST", body: {} }).then((r: { file: string }) =>
                setMsg(`Backup creado: ${r.file}`),
              )
            }
          >
            Backup ahora
          </button>
        )}
      </div>
      {msg && (
        <p className="small" style={{ color: "var(--color-ink)", flex: "none" }}>
          {msg}
        </p>
      )}

      {tab === "resumen" && d && (
        <div className="stats" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
          <Stat label="Ventas de hoy" value={money(d.sales_today_cents)} />
          <Stat label="Ticket promedio" value={money(d.average_ticket_cents)} />
          <Stat label="Mesas ocupadas" value={String(d.occupied_tables)} />
          <Stat label="Pedidos en cocina/bar" value={String(d.pending_tickets)} />
          <Stat label="Meseros activos" value={String(d.active_waiters)} />
          <Stat label="Cajas abiertas" value={String(d.open_cash_sessions)} />
          <Stat label="Productos agotados" value={String(d.unavailable_products)} />
          <Stat
            label="Errores de impresión"
            value={String(d.print_errors)}
            alert={d.print_errors > 0}
          />
        </div>
      )}

      {tab === "ventas" && (
        <div className="split">
          <section className="card fillcard">
            <h3>Más vendidos</h3>
            <PagedRows
              items={sales.data?.by_product ?? []}
              rowH={40}
              head={
                <tr>
                  <th>Producto</th>
                  <th className="r">Uds</th>
                  <th className="r">Ventas</th>
                </tr>
              }
              row={(p) => (
                <>
                  <td>{p.product}</td>
                  <td className="r num">{p.units}</td>
                  <td className="r num">{money(p.sales_cents)}</td>
                </>
              )}
              empty={<p className="muted">Sin ventas hoy</p>}
            />
          </section>
          <section className="card fillcard">
            <h3>Por mesero</h3>
            <PagedRows
              items={sales.data?.by_waiter ?? []}
              rowH={40}
              head={
                <tr>
                  <th>Mesero</th>
                  <th className="r">Cuentas</th>
                  <th className="r">Ventas</th>
                </tr>
              }
              row={(p) => (
                <>
                  <td>{p.waiter}</td>
                  <td className="r num">{p.tickets}</td>
                  <td className="r num">{money(p.sales_cents)}</td>
                </>
              )}
              empty={<p className="muted">Sin ventas hoy</p>}
            />
          </section>
          <section className="card fillcard">
            <h3>Por método de pago</h3>
            <PagedRows
              items={sales.data?.by_method ?? []}
              rowH={40}
              head={
                <tr>
                  <th>Método</th>
                  <th className="r">Total</th>
                </tr>
              }
              row={(p) => (
                <>
                  <td>{p.method}</td>
                  <td className="r num">{money(p.total_cents)}</td>
                </>
              )}
              empty={<p className="muted">Sin ventas hoy</p>}
            />
          </section>
        </div>
      )}

      {tab === "personal" && <StaffPanel />}
      {tab === "tarjetas" && <GiftCardsPanel />}
      {tab === "facturas" && <InvoiceList />}

      {tab === "impresoras" && (
        <div className="split">
          <section className="card fillcard">
            <h3>Estado de impresoras</h3>
            <PagedRows
              items={printers.data ?? []}
              rowH={56}
              row={(p) => (
                <td style={{ padding: 0 }}>
                  <div className="row spread" style={{ height: 56 }}>
                    <span>
                      <span
                        className="dot"
                        style={{
                          background: p.online ? "#000" : "transparent",
                          border: "1px solid #000",
                        }}
                      />
                      {p.name}{" "}
                      <span className="small">{p.online ? "conectada" : "sin respuesta"}</span>
                    </span>
                    <button className="btn sm" onClick={() => test(p.id)}>
                      Imprimir prueba
                    </button>
                  </div>
                </td>
              )}
            />
          </section>
          <section className="card fillcard">
            <h3 className={jobs.data?.length ? "err" : ""}>
              Impresiones con error · {jobs.data?.length ?? 0}
            </h3>
            <PagedRows
              items={jobs.data ?? []}
              rowH={56}
              empty={<p className="muted">Sin errores</p>}
              row={(j) => (
                <td style={{ padding: 0 }}>
                  <div className="row spread" style={{ height: 56 }}>
                    <span className="small ellipsis">
                      {j.kind} · {j.last_error}
                    </span>
                    <button
                      className="btn sm"
                      onClick={() =>
                        api(`/api/print-jobs/${j.id}/retry`, { body: {} }).then(() => jobs.reload())
                      }
                    >
                      Reintentar
                    </button>
                  </div>
                </td>
              )}
            />
          </section>
        </div>
      )}

      {tab === "auditoria" && (
        <section className="card fillcard">
          <PagedRows
            items={audit.data ?? []}
            rowH={40}
            head={
              <tr>
                <th>Hora</th>
                <th>Acción</th>
                <th>Entidad</th>
              </tr>
            }
            row={(a) => (
              <>
                <td className="num">
                  {new Date(a.ts).toLocaleTimeString("es-MX", { hour12: false })}
                </td>
                <td>{a.action}</td>
                <td className="small">{a.entity}</td>
              </>
            )}
          />
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className="card stat">
      <div className="small">{label}</div>
      <div className={`v num ${alert ? "err" : ""}`}>{value}</div>
    </div>
  );
}
