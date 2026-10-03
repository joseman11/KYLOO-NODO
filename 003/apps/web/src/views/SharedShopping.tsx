import { useEffect, useState } from "react";
import { api } from "../api";
import { NodoMark } from "../Logo";
import { PagedRows } from "../fit";

interface Shared {
  name: string;
  notes: string | null;
  status: string;
  establishment: string;
  lines: {
    id: string;
    name: string;
    unit: string | null;
    quantity: number;
    checked: boolean;
    note: string | null;
    area: string | null;
    category: string | null;
    supplier: string | null;
  }[];
}
const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

/** Lista de compras que alguien comparte por enlace: se abre sin iniciar sesión y se marca lo ya comprado. */
export function SharedShopping() {
  const token = new URLSearchParams(location.search).get("t") ?? "";
  const [data, setData] = useState<Shared | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () =>
    api<Shared>(`/api/shared/shopping/${token}`).then(
      (d) => {
        setData(d);
        setErr(null);
      },
      (e) => setErr((e as Error).message),
    );
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);
  const toggle = (id: string, checked: boolean) => {
    setData((d) => d && { ...d, lines: d.lines.map((l) => (l.id === id ? { ...l, checked } : l)) });
    api(`/api/shared/shopping/${token}/items/${id}`, { method: "PATCH", body: { checked } }).catch(
      (e) => {
        setErr((e as Error).message);
        load();
      },
    );
  };
  const done = data?.lines.filter((l) => l.checked).length ?? 0;
  const closed = data?.status === "comprada" || data?.status === "archivada";
  return (
    <div className="shared">
      <header className="row" style={{ flex: "none", gap: 12 }}>
        <NodoMark size={36} />
        <div style={{ minWidth: 0 }}>
          <div className="small">{data?.establishment ?? "Lista de compras"}</div>
          <h2 className="ellipsis">{data?.name ?? (err ? "Enlace no disponible" : "Cargando…")}</h2>
        </div>
      </header>
      {err && (
        <p className="err" style={{ flex: "none" }}>
          {err}
        </p>
      )}
      {data && (
        <>
          <div className="row spread" style={{ flex: "none" }}>
            <span className="tag">
              {done} de {data.lines.length} comprados
            </span>
            {closed && <span className="tag ember">Lista cerrada</span>}
          </div>
          {data.notes && (
            <p className="small" style={{ flex: "none" }}>
              {data.notes}
            </p>
          )}
          <section className="card fillcard">
            <PagedRows
              fixed
              items={data.lines}
              rowH={64}
              empty={<p className="muted">La lista está vacía</p>}
              row={(l) => (
                <td style={{ padding: 0 }}>
                  <button
                    type="button"
                    className="shared-row"
                    disabled={closed}
                    onClick={() => toggle(l.id, !l.checked)}
                    aria-pressed={l.checked}
                  >
                    <span className={`check ${l.checked ? "on" : ""}`}>{l.checked ? "✓" : ""}</span>
                    <span
                      className="grow ellipsis"
                      style={{
                        textAlign: "left",
                        textDecoration: l.checked ? "line-through" : undefined,
                        opacity: l.checked ? 0.55 : 1,
                      }}
                    >
                      <strong>{l.name}</strong>
                      <span className="small ellipsis" style={{ display: "block" }}>
                        {[l.area, l.category].filter(Boolean).join(" › ")}
                        {l.note ? ` · ${l.note}` : ""}
                      </span>
                    </span>
                    <strong className="num">
                      {fmt(l.quantity)} {l.unit}
                    </strong>
                  </button>
                </td>
              )}
            />
          </section>
        </>
      )}
    </div>
  );
}
