import { useEffect, useState } from "react";
import { api, can, useLive } from "../api";
import { PagedGrid } from "../fit";

interface PassTicket {
  id: string;
  status: string;
  station: string;
  created_at: number;
  ready_at: number | null;
  lines: { name: string; quantity: number; course: string | null }[];
}
interface PassCard {
  account_id: string;
  label: string;
  waiter: string;
  oldest: number;
  ready: boolean;
  tickets: PassTicket[];
  held: { course: string; n: number }[];
}

const STATUS: Record<string, string> = {
  pendiente: "Pendiente",
  recibido: "Recibido",
  preparando: "Preparando",
  listo: "Listo",
};
const mins = (ts: number) => Math.max(0, Math.floor((Date.now() - ts) / 60000));

/**
 * Pase (expo): todo lo que está en producción, agrupado por mesa. Muestra qué estación ya terminó,
 * cuándo la mesa está completa para llevarla, y los tiempos retenidos que aún no se mandan.
 */
export function Pass() {
  const pass = useLive(
    () => api<PassCard[]>("/api/pass"),
    ["ticket.updated", "order.created", "order.updated", "table.updated"],
  );
  const [, tick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 20000);
    return () => clearInterval(t);
  }, []);

  const act = (p: Promise<unknown>) =>
    p.then(
      () => {
        setErr(null);
        pass.reload();
      },
      (e) => setErr((e as Error).message),
    );
  const ready = (pass.data ?? []).filter((c) => c.ready).length;

  return (
    <div className="view">
      <div className="row spread" style={{ flex: "none" }}>
        <h2>Pase</h2>
        <span className="small">
          {(pass.data ?? []).length} mesas en producción · {ready} completas para llevar
        </span>
      </div>
      {err && (
        <p className="err" style={{ flex: "none" }}>
          {err}
        </p>
      )}
      <PagedGrid
        items={pass.data ?? []}
        minW={290}
        minH={190}
        empty={<p className="muted">Nada en producción</p>}
        render={(c) => (
          <div
            className="card"
            style={{
              height: "100%",
              padding: 12,
              display: "flex",
              flexDirection: "column",
              gap: 6,
              overflow: "hidden",
              borderWidth: c.ready ? 2 : 1,
              borderColor: c.ready ? "var(--color-ember)" : undefined,
            }}
          >
            <div className="row spread">
              <span style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em" }}>
                {/^\d/.test(c.label) ? `Mesa ${c.label}` : c.label}
              </span>
              {c.ready ? (
                <span className="tag ember">Todo listo</span>
              ) : (
                <span className="small">{mins(c.oldest)} min</span>
              )}
            </div>
            <div className="small">{c.waiter}</div>
            {c.tickets.map((t) => (
              <div
                key={t.id}
                className="row spread"
                style={{ borderTop: "1px solid var(--color-fog)", paddingTop: 4, gap: 6 }}
              >
                <div style={{ minWidth: 0 }}>
                  <div className="ellipsis" style={{ fontWeight: 600, fontSize: 14 }}>
                    {t.station}
                  </div>
                  <div className="small ellipsis">
                    {t.lines.map((l) => `${l.quantity} ${l.name}`).join(", ")}
                  </div>
                </div>
                <div className="row" style={{ gap: 4, flex: "none" }}>
                  <span className={`tag ${t.status === "listo" ? "ember" : ""}`}>
                    {STATUS[t.status] ?? t.status}
                  </span>
                  {t.status === "listo" && can("item.mark_delivered") && (
                    <button
                      className="btn primary sm"
                      onClick={() =>
                        act(api(`/api/tickets/${t.id}/status`, { body: { status: "entregado" } }))
                      }
                    >
                      Entregar
                    </button>
                  )}
                  {t.status === "listo" && can("station.update") && (
                    <button
                      className="btn ghost sm"
                      title="Devolver a cocina"
                      onClick={() =>
                        act(api(`/api/tickets/${t.id}/recall`, { method: "POST", body: {} }))
                      }
                    >
                      ↺
                    </button>
                  )}
                </div>
              </div>
            ))}
            {c.held.length > 0 && (
              <div
                className="row spread"
                style={{ borderTop: "1px dashed var(--color-mist)", paddingTop: 4 }}
              >
                <span className="small">
                  Retenido: {c.held.map((h) => `${h.course} (${h.n})`).join(", ")}
                </span>
                {can("order.create") && (
                  <button
                    className="btn sm"
                    onClick={() => act(api(`/api/accounts/${c.account_id}/fire`, { body: {} }))}
                  >
                    Mandar
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      />
    </div>
  );
}
