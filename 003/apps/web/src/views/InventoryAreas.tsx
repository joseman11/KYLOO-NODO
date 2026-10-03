import { useState } from "react";
import { api, useLive } from "../api";
import { PagedRows } from "../fit";

export interface Area {
  id: string;
  name: string;
  sort: number;
}
export interface Cat {
  id: string;
  area_id: string;
  name: string;
  sort: number;
}
export interface Supplier {
  id: string;
  name: string;
}
export interface Item {
  id: string;
  name: string;
  unit: string;
  stock: number;
  min_stock: number;
  max_stock: number | null;
  unit_cost_cents: number;
  area_id: string | null;
  category_id: string | null;
  supplier_id: string | null;
  active: number;
}

export const UNITS = ["g", "kg", "ml", "l", "pza", "paq", "caja", "lata", "botella"];
export const toNum = (v: string) => parseFloat(v.replace(",", ".")) || 0;
export const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

/** Áreas, categorías y proveedores del inventario (los define el usuario). */
export function useInventoryMeta() {
  const areas = useLive(() => api<Area[]>("/api/inventory/areas"), [], [], "inv-areas");
  const cats = useLive(() => api<Cat[]>("/api/inventory/categories"), [], [], "inv-cats");
  const suppliers = useLive(() => api<Supplier[]>("/api/suppliers"), [], [], "inv-suppliers");
  return {
    areas: areas.data ?? [],
    cats: cats.data ?? [],
    suppliers: suppliers.data ?? [],
    reload: () => {
      areas.reload();
      cats.reload();
      suppliers.reload();
    },
  };
}

/** Fila de filtros: áreas y, al elegir una, sus categorías. */
export function AreaBar({
  areas,
  cats,
  area,
  cat,
  onArea,
  onCat,
  extra,
}: {
  areas: Area[];
  cats: Cat[];
  area: string | null;
  cat: string | null;
  onArea: (a: string | null) => void;
  onCat: (c: string | null) => void;
  extra?: React.ReactNode;
}) {
  const mine = cats.filter((c) => c.area_id === area);
  return (
    <div className="col" style={{ gap: 8, flex: "none" }}>
      <div className="row wrap">
        <button
          className={`chip ${area === null ? "on" : ""}`}
          onClick={() => {
            onArea(null);
            onCat(null);
          }}
        >
          Todas las áreas
        </button>
        {areas.map((a) => (
          <button
            key={a.id}
            className={`chip ${area === a.id ? "on" : ""}`}
            onClick={() => {
              onArea(a.id);
              onCat(null);
            }}
          >
            {a.name}
          </button>
        ))}
        <span className="grow" />
        {extra}
      </div>
      {area && mine.length > 0 && (
        <div className="row wrap">
          <button className={`chip sub ${cat === null ? "on" : ""}`} onClick={() => onCat(null)}>
            Todo {areas.find((a) => a.id === area)?.name}
          </button>
          {mine.map((c) => (
            <button
              key={c.id}
              className={`chip sub ${cat === c.id ? "on" : ""}`}
              onClick={() => onCat(c.id)}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Alta y edición de un insumo: dónde vive, cuánto debe haber y cuándo pedir. */
export function ItemSheet({
  item,
  meta,
  onClose,
}: {
  item: Item | null;
  meta: ReturnType<typeof useInventoryMeta>;
  onClose: (changed: boolean) => void;
}) {
  const [f, setF] = useState({
    name: item?.name ?? "",
    unit: item?.unit ?? "kg",
    area: item?.area_id ?? "",
    cat: item?.category_id ?? "",
    supplier: item?.supplier_id ?? "",
    min: item ? String(item.min_stock) : "",
    max: item?.max_stock != null ? String(item.max_stock) : "",
    cost: item ? String(Math.round(item.unit_cost_cents * 100) / 100) : "",
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cats = meta.cats.filter((c) => c.area_id === f.area);
  const save = () => {
    setBusy(true);
    const body = {
      name: f.name.trim(),
      unit: f.unit,
      min_stock: toNum(f.min),
      max_stock: f.max.trim() ? toNum(f.max) : null,
      unit_cost_cents: toNum(f.cost),
      area_id: f.area || null,
      category_id: f.area && f.cat ? f.cat : null,
      supplier_id: f.supplier || null,
    };
    (item
      ? api(`/api/inventory/items/${item.id}`, { method: "PATCH", body })
      : api("/api/inventory/items", { body })
    ).then(
      () => onClose(true),
      (e) => {
        setErr((e as Error).message);
        setBusy(false);
      },
    );
  };
  return (
    <div className="sheet-bg" onClick={() => !busy && onClose(false)}>
      <div
        className="sheet center"
        style={{ width: "min(640px, 100%)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{item ? "Editar insumo" : "Nuevo insumo"}</h3>
        <div className="grid2">
          <input
            autoFocus
            placeholder="Nombre"
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
          />
          <select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>
            {UNITS.map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
          <select value={f.area} onChange={(e) => setF({ ...f, area: e.target.value, cat: "" })}>
            <option value="">Área…</option>
            {meta.areas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select
            value={f.cat}
            disabled={!f.area}
            onChange={(e) => setF({ ...f, cat: e.target.value })}
          >
            <option value="">{f.area ? "Categoría…" : "Elige primero el área"}</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })}>
            <option value="">Proveedor habitual…</option>
            {meta.suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <input
            placeholder="Costo por unidad (¢)"
            inputMode="decimal"
            value={f.cost}
            onChange={(e) => setF({ ...f, cost: e.target.value })}
          />
          <input
            placeholder={`Mínimo (${f.unit}) · aquí se avisa`}
            inputMode="decimal"
            value={f.min}
            onChange={(e) => setF({ ...f, min: e.target.value })}
          />
          <input
            placeholder={`Máximo (${f.unit}) · hasta aquí se pide`}
            inputMode="decimal"
            value={f.max}
            onChange={(e) => setF({ ...f, max: e.target.value })}
          />
        </div>
        <p className="small">
          Cuando la existencia llegue al mínimo aparece en <b>Por pedir</b> y se sugiere comprar
          hasta el máximo. Sin mínimo no hay aviso.
        </p>
        {err && <p className="err">{err}</p>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn" disabled={busy} onClick={() => onClose(false)}>
            Cancelar
          </button>
          <button className="btn primary" disabled={busy || !f.name.trim()} onClick={save}>
            Guardar
          </button>
        </div>
      </div>
    </div>
  );
}

/** Administra las áreas y las categorías de cada área (crear, renombrar, borrar). */
export function AreasSheet({
  meta,
  onClose,
}: {
  meta: ReturnType<typeof useInventoryMeta>;
  onClose: () => void;
}) {
  const [sel, setSel] = useState<string | null>(meta.areas[0]?.id ?? null);
  const [newArea, setNewArea] = useState("");
  const [newCat, setNewCat] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const run = (p: Promise<unknown>, after?: () => void) =>
    p.then(
      () => {
        setErr(null);
        meta.reload();
        after?.();
      },
      (e) => setErr((e as Error).message),
    );
  const mine = meta.cats.filter((c) => c.area_id === sel);
  const rename = (path: string, current: string, v: string) => {
    const name = v.trim();
    if (name && name !== current) run(api(path, { method: "PATCH", body: { name } }));
  };
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div
        className="sheet center"
        style={{ width: "min(860px, 100%)", height: "min(560px, 100%)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row spread">
          <h3>Áreas y categorías del inventario</h3>
          <button className="btn sm" onClick={onClose}>
            Cerrar
          </button>
        </div>
        <p className="small">
          Organízalo como lo usas: por ejemplo Cocina › Perecederos, Mariscos, Enlatados; Barra ›
          Licores, Cervezas.
        </p>
        {err && <p className="err">{err}</p>}
        <div className="split" style={{ gap: 16 }}>
          <section className="col" style={{ flex: 1, minWidth: 0 }}>
            <strong>Áreas</strong>
            <PagedRows
              fixed
              items={meta.areas}
              rowH={52}
              row={(a) => (
                <td style={{ padding: 0 }}>
                  <div className="row" style={{ height: 52, gap: 6 }}>
                    <button
                      className={`opt ${sel === a.id ? "on" : ""}`}
                      style={{ minHeight: 40, padding: "0 12px" }}
                      onClick={() => setSel(a.id)}
                    >
                      ›
                    </button>
                    <input
                      className="grow"
                      defaultValue={a.name}
                      aria-label={`Nombre del área ${a.name}`}
                      onBlur={(e) => rename(`/api/inventory/areas/${a.id}`, a.name, e.target.value)}
                    />
                    <button
                      className="btn ghost sm"
                      aria-label={`Borrar ${a.name}`}
                      onClick={() =>
                        run(
                          api(`/api/inventory/areas/${a.id}`, { method: "DELETE" }),
                          () => sel === a.id && setSel(null),
                        )
                      }
                    >
                      ✕
                    </button>
                  </div>
                </td>
              )}
            />
            <div className="row">
              <input
                className="grow"
                placeholder="Nueva área (Cocina, Barra, Almacén…)"
                value={newArea}
                onChange={(e) => setNewArea(e.target.value)}
              />
              <button
                className="btn"
                disabled={!newArea.trim()}
                onClick={() =>
                  run(api("/api/inventory/areas", { body: { name: newArea.trim() } }), () =>
                    setNewArea(""),
                  )
                }
              >
                Agregar
              </button>
            </div>
          </section>
          <section className="col" style={{ flex: 1, minWidth: 0 }}>
            <strong>Categorías de {meta.areas.find((a) => a.id === sel)?.name ?? "—"}</strong>
            <PagedRows
              fixed
              items={mine}
              rowH={52}
              empty={
                <p className="muted small">
                  {sel ? "Esta área aún no tiene categorías" : "Elige un área"}
                </p>
              }
              row={(c) => (
                <td style={{ padding: 0 }}>
                  <div className="row" style={{ height: 52, gap: 6 }}>
                    <input
                      className="grow"
                      defaultValue={c.name}
                      aria-label={`Nombre de la categoría ${c.name}`}
                      onBlur={(e) =>
                        rename(`/api/inventory/categories/${c.id}`, c.name, e.target.value)
                      }
                    />
                    <button
                      className="btn ghost sm"
                      aria-label={`Borrar ${c.name}`}
                      onClick={() =>
                        run(api(`/api/inventory/categories/${c.id}`, { method: "DELETE" }))
                      }
                    >
                      ✕
                    </button>
                  </div>
                </td>
              )}
            />
            <div className="row">
              <input
                className="grow"
                disabled={!sel}
                placeholder="Nueva categoría (Perecederos, Mariscos…)"
                value={newCat}
                onChange={(e) => setNewCat(e.target.value)}
              />
              <button
                className="btn"
                disabled={!sel || !newCat.trim()}
                onClick={() =>
                  run(
                    api("/api/inventory/categories", {
                      body: { area_id: sel, name: newCat.trim() },
                    }),
                    () => setNewCat(""),
                  )
                }
              >
                Agregar
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
