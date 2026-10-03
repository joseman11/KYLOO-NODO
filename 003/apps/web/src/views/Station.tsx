import { useEffect, useState } from "react";
import { api, can, useLive } from "../api";
import { PagedColumns } from "../fit";

interface StationRow {
  id: string;
  name: string;
  subarea_id: string;
}
interface Ticket {
  id: string;
  status: string;
  folio: number;
  is_addition: number;
  table_number: string;
  waiter: string;
  created_at: number;
  lines: {
    id: string;
    name: string;
    quantity: number;
    modifiers: string[];
    note: string | null;
    course: string | null;
    status: string;
  }[];
}

const NEXT: Record<string, { to: string; label: string }> = {
  pendiente: { to: "preparando", label: "Preparar" },
  recibido: { to: "preparando", label: "Preparar" },
  preparando: { to: "listo", label: "Listo" },
  listo: { to: "entregado", label: "Entregado" },
};
/** Minutos tras los cuales un ticket se marca como retrasado (acento). */
const LATE_MIN = 15;

/** Altura estimada de un ticket para repartirlos en columnas sin desplazamiento. */
const estimate = (t: Ticket) =>
  150 +
  t.lines.reduce(
    (s, l, i) =>
      s +
      28 +
      l.modifiers.length * 18 +
      (l.note ? 18 : 0) +
      (l.course && l.course !== t.lines[i - 1]?.course ? 30 : 0),
    0,
  );

export function Station() {
  const stations = useLive(() => api<StationRow[]>("/api/stations"), []);
  const [stationId, setStationId] = useState<string | null>(() =>
    localStorage.getItem("003.station"),
  );
  const queue = useLive(
    () => (stationId ? api<Ticket[]>(`/api/stations/${stationId}/queue`) : Promise.resolve([])),
    ["order.created", "order.updated", "ticket.updated"],
    [stationId],
  );
  const [now, setNow] = useState(Date.now());
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  const choose = (id: string) => {
    setStationId(id);
    try {
      localStorage.setItem("003.station", id);
    } catch {
      /* ignorar */
    }
  };

  const advance = (t: Ticket) => {
    const n = NEXT[t.status];
    if (!n) return;
    api(`/api/tickets/${t.id}/status`, { body: { status: n.to } }).then(
      () => queue.reload(),
      (e) => setErr((e as Error).message),
    );
  };

  const soldOut = async () => {
    const products =
      await api<{ id: string; name: string; availability: string }[]>("/api/products");
    const name = prompt(
      "Producto a marcar agotado:\n" +
        products
          .filter((p) => p.availability === "disponible")
          .map((p) => p.name)
          .join(", "),
    );
    const p = products.find((x) => x.name.toLowerCase() === name?.trim().toLowerCase());
    if (p) await api(`/api/products/${p.id}/availability`, { body: { availability: "agotado" } });
  };

  return (
    <div className="kds">
      <div className="row wrap" style={{ flex: "none" }}>
        <h2 className="grow">
          {stations.data?.find((s) => s.id === stationId)?.name ?? "Elige estación"}{" "}
          <span className="small">{queue.data?.length ?? 0} comandas</span>
        </h2>
        {stations.data?.map((s) => (
          <button
            type="button"
            key={s.id}
            className={`btn ${s.id === stationId ? "active" : ""}`}
            onClick={() => choose(s.id)}
          >
            {s.name}
          </button>
        ))}
        {can("station.update") && stationId && (
          <button type="button" className="btn" onClick={soldOut}>
            Agotar producto
          </button>
        )}
      </div>
      {err && <p className="err">{err}</p>}
      <PagedColumns
        items={queue.data ?? []}
        colMinW={270}
        est={estimate}
        empty={<p className="muted">Sin comandas pendientes</p>}
        render={(t) => {
          const min = Math.floor((now - t.created_at) / 60000);
          const late = min >= LATE_MIN && t.status !== "listo";
          const n = NEXT[t.status];
          return (
            <div className={`ticket ${late ? "late" : ""}`}>
              <div className="row spread">
                <span className="mesa">
                  {t.table_number.length <= 3 && /^\d/.test(t.table_number)
                    ? `Mesa ${t.table_number}`
                    : t.table_number}
                </span>
                {t.is_addition ? (
                  <span className="tag ember">ADICIÓN</span>
                ) : (
                  <span className="tag" style={{ color: "#000" }}>
                    #{t.folio}
                  </span>
                )}
              </div>
              <div className="row spread small">
                <span>{t.waiter}</span>
                <span className={`timer ${late ? "late" : ""}`}>{min} min</span>
              </div>
              {t.lines.map((l, i) => (
                <div
                  key={l.id}
                  style={{
                    opacity: l.status === "cancelado" ? 0.4 : 1,
                    textDecoration: l.status === "cancelado" ? "line-through" : undefined,
                  }}
                >
                  {l.course && l.course !== t.lines[i - 1]?.course && (
                    <div
                      className="tag ember"
                      style={{
                        display: "block",
                        textAlign: "center",
                        margin: "4px 0",
                        textTransform: "uppercase",
                      }}
                    >
                      ── {l.course} ──
                    </div>
                  )}
                  <strong>
                    {l.quantity} × {l.name}
                  </strong>
                  {l.modifiers.map((m) => (
                    <div key={m} className="small">
                      - {m}
                    </div>
                  ))}
                  {l.note && <div className="small">» {l.note}</div>}
                </div>
              ))}
              {n && (
                <button
                  type="button"
                  className={`btn ${t.status === "preparando" ? "primary" : ""}`}
                  style={{ minHeight: 52 }}
                  onClick={() => advance(t)}
                >
                  {n.label}
                </button>
              )}
            </div>
          );
        }}
      />
    </div>
  );
}
