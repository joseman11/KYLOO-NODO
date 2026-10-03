import { useEffect, useState } from "react";
import { api, can, useLive } from "../api";
import { PagedColumns } from "../fit";
import { backdrop } from "../sheet";
import { Hint, StatusChip } from "../ui";

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

  // Sin estación elegida (o si la guardada ya no existe) se entra a la primera: nadie debe empezar con una pantalla vacía
  useEffect(() => {
    const list = stations.data;
    if (list?.length && !list.some((s) => s.id === stationId)) choose(list[0]!.id);
    // biome-ignore lint/correctness/useExhaustiveDependencies: solo al cargar la lista de estaciones
  }, [stations.data]);

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

  const [soldOutOpen, setSoldOutOpen] = useState(false);

  return (
    <div className="kds">
      <div className="row wrap" style={{ flex: "none" }}>
        <h2 className="grow">
          {stations.data?.find((s) => s.id === stationId)?.name ?? "Elige tu estación"}{" "}
          <span className="small">
            {queue.data?.length ?? 0} {queue.data?.length === 1 ? "comanda" : "comandas"}
          </span>
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
          <button type="button" className="btn" onClick={() => setSoldOutOpen(true)}>
            Agotados
          </button>
        )}
      </div>
      <Hint id="cocina">
        Toca <strong>Preparar</strong> al empezar y <strong>Listo</strong> al terminar: el mesero lo
        ve al instante. Las comandas con más de {LATE_MIN} min se marcan en rojo.
      </Hint>
      {err && <p className="err">{err}</p>}
      {soldOutOpen && <SoldOutSheet onClose={() => setSoldOutOpen(false)} />}
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
                <span className="row" style={{ gap: 6 }}>
                  {late && (
                    <StatusChip tone="bad" icon="alerta">
                      Retrasada
                    </StatusChip>
                  )}
                  <span className={`timer ${late ? "late" : ""}`}>{min} min</span>
                </span>
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
                  className={`btn ${t.status === "preparando" ? "ok" : ""}`}
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

interface Product {
  id: string;
  name: string;
  availability: string;
}

/** Marcar qué se acabó (y volverlo a poner disponible), con búsqueda y sin teclear nombres exactos. */
function SoldOutSheet({ onClose }: { onClose: () => void }) {
  const products = useLive(() => api<Product[]>("/api/products"), ["product.updated"]);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const set = (p: Product, availability: string) =>
    api(`/api/products/${p.id}/availability`, { body: { availability } }).then(
      () => products.reload(),
      (e) => setErr((e as Error).message),
    );
  const all = (products.data ?? []).filter((p) =>
    p.name.toLowerCase().includes(q.trim().toLowerCase()),
  );
  const out = all.filter((p) => p.availability === "agotado");
  const available = all.filter((p) => p.availability === "disponible").slice(0, 24);
  return (
    <div className="sheet-bg" {...backdrop(onClose)}>
      <div
        className="sheet center"
        role="dialog"
        aria-modal="true"
        style={{ width: "min(640px, 100%)" }}
      >
        <div className="row spread">
          <h3>Productos agotados</h3>
          <button type="button" className="btn" onClick={onClose}>
            Cerrar
          </button>
        </div>
        {/* biome-ignore lint/a11y/noAutofocus: la búsqueda es lo primero que se usa */}
        <input
          autoFocus
          placeholder="Buscar producto…"
          aria-label="Buscar producto"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {err && <p className="err">{err}</p>}
        {out.length > 0 && (
          <>
            <strong>Agotados ahora</strong>
            <div className="chips">
              {out.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className="chip on"
                  onClick={() => set(p, "disponible")}
                >
                  {p.name} · volver a poner
                </button>
              ))}
            </div>
          </>
        )}
        <strong>Toca el que se acabó</strong>
        <div className="chips">
          {available.map((p) => (
            <button type="button" key={p.id} className="chip" onClick={() => set(p, "agotado")}>
              {p.name}
            </button>
          ))}
          {available.length === 0 && <span className="muted">No hay coincidencias</span>}
        </div>
      </div>
    </div>
  );
}
