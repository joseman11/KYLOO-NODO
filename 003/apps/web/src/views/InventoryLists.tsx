import { useState } from "react";
import { api, can, useLive } from "../api";
import { PagedRows } from "../fit";
import { fmt, toNum, UNITS, type Item } from "./InventoryAreas";

export interface ListSummary {
  id: string;
  name: string;
  kind: "auto" | "manual";
  status: string;
  share_token: string | null;
  created_at: number;
  items: number;
  checked: number;
}
interface Line {
  id: string;
  item_id: string | null;
  name: string;
  unit: string | null;
  quantity: number;
  checked: number;
  note: string | null;
  area: string | null;
  category: string | null;
  supplier: string | null;
  stock: number | null;
  min_stock: number | null;
}
interface ListDetail extends ListSummary {
  notes: string | null;
  lines: Line[];
}

const STATUS: Record<string, string> = {
  abierta: "Abierta",
  compartida: "Compartida",
  comprada: "Comprada",
  archivada: "Archivada",
};
const day = (ts: number) =>
  new Date(ts).toLocaleDateString("es-MX", { day: "numeric", month: "short" });

/** Listas de compras: automáticas (lo que llegó al mínimo) o manuales, con opción de compartirlas. */
export function Lists({
  items,
  initialOpen,
  onOpened,
}: {
  items: Item[];
  initialOpen?: string | null;
  onOpened?: () => void;
}) {
  const lists = useLive(
    () => api<ListSummary[]>("/api/shopping-lists"),
    ["shopping.updated", "inventory.alert"],
  );
  const [open, setOpen] = useState<string | null>(initialOpen ?? null);
  const [err, setErr] = useState<string | null>(null);
  const edit = can("inventory.modify");
  const create = (auto: boolean) =>
    api<{ id: string; items: number }>("/api/shopping-lists", { body: { auto } }).then(
      (r) => {
        lists.reload();
        setOpen(r.id);
      },
      (e) => setErr((e as Error).message),
    );
  return (
    <section className="card fillcard">
      <div className="row spread" style={{ flex: "none" }}>
        <span className="small">
          Arma tu lista con lo que ya llegó al mínimo, o agrega artículos a mano, y compártela con
          quien va a comprar.
        </span>
        {edit && (
          <div className="row">
            <button className="btn" onClick={() => create(false)}>
              + Lista manual
            </button>
            <button className="btn primary" onClick={() => create(true)}>
              Desde lo que falta
            </button>
          </div>
        )}
      </div>
      {err && <p className="err">{err}</p>}
      <PagedRows
        items={lists.data ?? []}
        rowH={60}
        empty={<p className="muted">Aún no hay listas de compras</p>}
        head={
          <tr>
            <th>Lista</th>
            <th>Tipo</th>
            <th>Estado</th>
            <th className="r">Comprado</th>
            <th>Fecha</th>
            <th />
          </tr>
        }
        row={(l) => (
          <>
            <td className="ellipsis" style={{ maxWidth: 260 }}>
              <strong>{l.name}</strong>
            </td>
            <td className="small">{l.kind === "auto" ? "Automática" : "Manual"}</td>
            <td>
              <span className={`tag ${l.status === "abierta" ? "" : ""}`}>
                {STATUS[l.status] ?? l.status}
              </span>
            </td>
            <td className="r num">
              {l.checked}/{l.items}
            </td>
            <td className="small">{day(l.created_at)}</td>
            <td className="r">
              <button className="btn sm" onClick={() => setOpen(l.id)}>
                Abrir
              </button>
            </td>
          </>
        )}
      />
      {open && (
        <ListSheet
          id={open}
          items={items}
          onClose={() => {
            setOpen(null);
            onOpened?.();
            lists.reload();
          }}
        />
      )}
    </section>
  );
}

function ListSheet({ id, items, onClose }: { id: string; items: Item[]; onClose: () => void }) {
  const list = useLive(
    () => api<ListDetail>(`/api/shopping-lists/${id}`),
    ["shopping.updated"],
    [id],
  );
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [share, setShare] = useState<{
    token: string;
    path: string;
    text: string;
    whatsapp: string;
  } | null>(null);
  const [add, setAdd] = useState({ item: "", name: "", qty: "", unit: "" });
  const [sure, setSure] = useState(false);
  const d = list.data;
  const closed = d?.status === "comprada" || d?.status === "archivada";
  const edit = can("inventory.modify") && !closed;
  const run = (p: Promise<unknown>, after?: () => void) =>
    p.then(
      () => {
        setErr(null);
        list.reload();
        after?.();
      },
      (e) => setErr((e as Error).message),
    );
  const doShare = () =>
    api<{ token: string; path: string; text: string; whatsapp: string }>(
      `/api/shopping-lists/${id}/share`,
      { body: {} },
    ).then(setShare, (e) => setErr((e as Error).message));
  const chosen = items.find((i) => i.id === add.item);
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div
        className="sheet center"
        style={{ width: "min(900px, 100%)", height: "100%" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row spread">
          <div style={{ minWidth: 0 }}>
            {edit ? (
              <input
                aria-label="Nombre de la lista"
                defaultValue={d?.name ?? ""}
                key={d?.name}
                style={{ fontSize: 20, fontWeight: 700, minHeight: 44 }}
                onBlur={(e) =>
                  e.target.value.trim() &&
                  e.target.value !== d?.name &&
                  run(
                    api(`/api/shopping-lists/${id}`, {
                      method: "PATCH",
                      body: { name: e.target.value.trim() },
                    }),
                  )
                }
              />
            ) : (
              <h3 className="ellipsis">{d?.name}</h3>
            )}
          </div>
          <div className="row">
            <span className="tag">{STATUS[d?.status ?? ""] ?? ""}</span>
            <button className="btn sm" onClick={onClose}>
              Cerrar
            </button>
          </div>
        </div>
        {err && <p className="err">{err}</p>}
        {msg && <p className="small">{msg}</p>}
        <PagedRows
          fixed
          items={d?.lines ?? []}
          rowH={56}
          empty={
            <p className="muted">
              La lista está vacía. Agrega artículos abajo
              {edit ? " o toca «Actualizar» para traer lo que falta" : ""}.
            </p>
          }
          head={
            <tr>
              <th style={{ width: 52 }} />
              <th>Artículo</th>
              <th style={{ width: 150 }}>Grupo</th>
              <th className="r" style={{ width: 130 }}>
                Cantidad
              </th>
              <th style={{ width: 52 }} />
            </tr>
          }
          row={(l) => (
            <>
              <td>
                <button
                  className={`check ${l.checked ? "on" : ""}`}
                  disabled={closed}
                  aria-label={l.checked ? `Desmarcar ${l.name}` : `Marcar ${l.name}`}
                  onClick={() =>
                    run(
                      api(`/api/shopping-lists/${id}/items/${l.id}`, {
                        method: "PATCH",
                        body: { checked: !l.checked },
                      }),
                    )
                  }
                >
                  {l.checked ? "✓" : ""}
                </button>
              </td>
              <td
                className="ellipsis"
                style={{
                  textDecoration: l.checked ? "line-through" : undefined,
                  opacity: l.checked ? 0.55 : 1,
                }}
              >
                <strong>{l.name}</strong>
                <div className="small ellipsis">
                  {l.stock != null
                    ? `Hay ${fmt(l.stock)}${l.min_stock ? ` · mín. ${fmt(l.min_stock)}` : ""}`
                    : "Artículo libre"}
                  {l.supplier ? ` · ${l.supplier}` : ""}
                  {l.note ? ` · ${l.note}` : ""}
                </div>
              </td>
              <td className="small ellipsis">
                {[l.area, l.category].filter(Boolean).join(" › ") || "—"}
              </td>
              <td className="r">
                {edit ? (
                  <span className="row" style={{ justifyContent: "flex-end", gap: 4 }}>
                    <input
                      aria-label={`Cantidad de ${l.name}`}
                      inputMode="decimal"
                      style={{ width: 76, minHeight: 40, textAlign: "right" }}
                      defaultValue={fmt(l.quantity)}
                      key={l.quantity}
                      onBlur={(e) => {
                        const q = toNum(e.target.value);
                        if (q > 0 && q !== l.quantity)
                          run(
                            api(`/api/shopping-lists/${id}/items/${l.id}`, {
                              method: "PATCH",
                              body: { quantity: q },
                            }),
                          );
                      }}
                    />
                    <span className="small">{l.unit}</span>
                  </span>
                ) : (
                  <span className="num">
                    {fmt(l.quantity)} {l.unit}
                  </span>
                )}
              </td>
              <td className="r">
                {edit && (
                  <button
                    className="btn ghost sm"
                    aria-label={`Quitar ${l.name}`}
                    onClick={() =>
                      run(api(`/api/shopping-lists/${id}/items/${l.id}`, { method: "DELETE" }))
                    }
                  >
                    ✕
                  </button>
                )}
              </td>
            </>
          )}
        />
        {edit && (
          <div className="row wrap" style={{ flex: "none" }}>
            <select
              style={{ width: 210 }}
              value={add.item}
              onChange={(e) => setAdd({ ...add, item: e.target.value, name: "" })}
            >
              <option value="">Insumo del inventario…</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
            <input
              style={{ width: 170 }}
              placeholder="o artículo libre"
              value={add.name}
              disabled={!!add.item}
              onChange={(e) => setAdd({ ...add, name: e.target.value })}
            />
            <input
              style={{ width: 90 }}
              placeholder="Cantidad"
              inputMode="decimal"
              value={add.qty}
              onChange={(e) => setAdd({ ...add, qty: e.target.value })}
            />
            <select
              style={{ width: 90 }}
              value={add.item ? (chosen?.unit ?? "") : add.unit}
              disabled={!!add.item}
              onChange={(e) => setAdd({ ...add, unit: e.target.value })}
            >
              <option value="">u.</option>
              {UNITS.map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
            <button
              className="btn"
              disabled={!toNum(add.qty) || (!add.item && !add.name.trim())}
              onClick={() =>
                run(
                  api(`/api/shopping-lists/${id}/items`, {
                    body: {
                      itemId: add.item || undefined,
                      name: add.item ? undefined : add.name.trim(),
                      unit: add.item ? undefined : add.unit || undefined,
                      quantity: toNum(add.qty),
                    },
                  }),
                  () => setAdd({ item: "", name: "", qty: "", unit: "" }),
                )
              }
            >
              Agregar
            </button>
          </div>
        )}
        <div className="row wrap" style={{ flex: "none", justifyContent: "space-between" }}>
          <div className="row wrap">
            {edit && (
              <button
                className="btn"
                onClick={() =>
                  run(
                    api<{ added: number }>(`/api/shopping-lists/${id}/refresh`, { body: {} }).then(
                      (r) =>
                        setMsg(
                          r.added
                            ? `Se agregaron ${r.added} artículo(s) que ya llegaron al mínimo`
                            : "No hay nada nuevo por pedir",
                        ),
                    ),
                  )
                }
              >
                Actualizar
              </button>
            )}
            {can("purchase.manage") && (
              <button
                className="btn"
                onClick={() =>
                  run(
                    api<{ orders: string[]; unassigned: string[] }>(
                      `/api/shopping-lists/${id}/purchase-orders`,
                      { body: {} },
                    ).then((r) =>
                      setMsg(
                        `${r.orders.length} orden(es) de compra en borrador${r.unassigned.length ? ` · sin proveedor: ${r.unassigned.length}` : ""}`,
                      ),
                    ),
                  )
                }
              >
                Órdenes de compra
              </button>
            )}
            {can("inventory.modify") &&
              !closed &&
              (sure ? (
                <button
                  className="btn"
                  style={{ color: "var(--bad)" }}
                  onClick={() =>
                    run(api(`/api/shopping-lists/${id}`, { method: "DELETE" }), onClose)
                  }
                >
                  ¿Seguro? Sí, eliminar
                </button>
              ) : (
                <button className="btn ghost" onClick={() => setSure(true)}>
                  Eliminar
                </button>
              ))}
          </div>
          <div className="row wrap">
            <button className="btn" onClick={doShare}>
              Compartir
            </button>
            {edit && (
              <button
                className="btn primary"
                disabled={!d?.lines.some((l) => l.checked)}
                onClick={() =>
                  run(
                    api<{ received: number }>(`/api/shopping-lists/${id}/receive`, {
                      body: {},
                    }).then((r) => setMsg(`Entraron ${r.received} artículo(s) al inventario`)),
                  )
                }
              >
                Ya compré: entrar al inventario
              </button>
            )}
          </div>
        </div>
      </div>
      {share && (
        <ShareSheet
          data={share}
          listId={id}
          onClose={() => setShare(null)}
          onUnshare={() => {
            run(api(`/api/shopping-lists/${id}/unshare`, { body: {} }));
            setShare(null);
          }}
        />
      )}
    </div>
  );
}

function ShareSheet({
  data,
  listId,
  onClose,
  onUnshare,
}: {
  data: { token: string; path: string; text: string; whatsapp: string };
  listId: string;
  onClose: () => void;
  onUnshare: () => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const url = `${location.origin}${data.path}`;
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNote(`${what} copiado`);
    } catch {
      setNote("No se pudo copiar: selecciona el texto y cópialo");
    }
  };
  const nativeShare = typeof navigator.share === "function";
  return (
    <div
      className="sheet-bg"
      style={{ zIndex: 12 }}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="sheet center"
        style={{ width: "min(640px, 100%)", height: "min(520px, 100%)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Compartir lista</h3>
        <p className="small">
          Quien abra el enlace ve la lista y puede marcar lo que ya compró, sin iniciar sesión.
        </p>
        <div className="row">
          <input
            className="grow"
            readOnly
            value={url}
            aria-label="Enlace de la lista"
            onFocus={(e) => e.target.select()}
          />
          <button className="btn" onClick={() => copy(url, "Enlace")}>
            Copiar enlace
          </button>
        </div>
        <pre className="share-text" aria-label="Texto de la lista">
          {data.text}
        </pre>
        {note && <p className="small">{note}</p>}
        <div className="row wrap">
          <a
            className="btn primary"
            href={data.whatsapp}
            target="_blank"
            rel="noreferrer"
            style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}
          >
            WhatsApp
          </a>
          <button className="btn" onClick={() => copy(data.text, "Texto")}>
            Copiar texto
          </button>
          {nativeShare && (
            <button
              className="btn"
              onClick={() =>
                navigator
                  .share({ title: "Lista de compras", text: data.text, url })
                  .catch(() => undefined)
              }
            >
              Compartir…
            </button>
          )}
          <button className="btn" onClick={() => window.print()}>
            Imprimir
          </button>
          <button className="btn ghost" onClick={onUnshare}>
            Dejar de compartir
          </button>
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            Listo
          </button>
        </div>
        <span hidden data-list={listId} />
      </div>
    </div>
  );
}
