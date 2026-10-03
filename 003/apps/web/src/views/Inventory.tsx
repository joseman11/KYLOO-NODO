import { StatusChip } from "../ui";
import { useState } from "react";
import { backdrop } from "../sheet";
import { api, can, money, useLive } from "../api";
import { PagedRows, SubTabs } from "../fit";
import {
  AreaBar,
  AreasSheet,
  fmt,
  ItemSheet,
  toNum,
  useInventoryMeta,
  type Item,
  type Supplier,
} from "./InventoryAreas";
import { Lists } from "./InventoryLists";

interface Product {
  id: string;
  name: string;
  price_cents: number;
}
interface PO {
  id: string;
  supplier: string;
  status: string;
  total_cents: number;
  created_at: number;
  lines: { item: string; quantity: number; unit: string; unit_cost_cents: number }[];
}
interface Alert {
  itemId: string;
  name: string;
  level: string;
  stock: number;
}
interface Reorder {
  itemId: string;
  name: string;
  unit: string;
  stock: number;
  min_stock: number;
  max_stock: number | null;
  suggested: number;
  level: "agotado" | "bajo";
  area_id: string | null;
  area: string | null;
  category_id: string | null;
  category: string | null;
  supplier: string | null;
}

type Tab = "stock" | "reorder" | "listas" | "recetas" | "compras";

export function Inventory() {
  const [tab, setTab] = useState<Tab>("stock");
  const [openList, setOpenList] = useState<string | null>(null);
  const reorder = useLive(
    () => api<Reorder[]>("/api/inventory/reorder"),
    ["inventory.alert", "order.created"],
  );
  const items = useLive(
    () => api<Item[]>("/api/inventory/items"),
    ["inventory.alert", "order.created"],
  );
  const n = reorder.data?.length ?? 0;
  return (
    <div className="view">
      <SubTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "stock", label: "Existencias" },
          { id: "reorder", label: n ? `Por pedir (${n})` : "Por pedir" },
          { id: "listas", label: "Listas de compras" },
          { id: "recetas", label: "Recetas y costos" },
          { id: "compras", label: "Compras" },
        ]}
      />
      {tab === "stock" && <Stock items={items} />}
      {tab === "reorder" && (
        <ReorderTab
          rows={reorder.data ?? []}
          onList={(id) => {
            setOpenList(id);
            setTab("listas");
          }}
        />
      )}
      {tab === "listas" && (
        <Lists items={items.data ?? []} initialOpen={openList} onOpened={() => setOpenList(null)} />
      )}
      {tab === "recetas" && <Recipes />}
      {tab === "compras" && <Purchases />}
    </div>
  );
}

function Stock({ items }: { items: { data: Item[] | null; reload: () => void } }) {
  const alerts = useLive(
    () => api<Alert[]>("/api/inventory/alerts"),
    ["inventory.alert", "order.created"],
  );
  const meta = useInventoryMeta();
  const [area, setArea] = useState<string | null>(null);
  const [cat, setCat] = useState<string | null>(null);
  const [move, setMove] = useState<Item | null>(null);
  const [form, setForm] = useState<Item | "new" | null>(null);
  const [manage, setManage] = useState(false);
  const alertOf = (id: string) => alerts.data?.find((a) => a.itemId === id)?.level;
  const edit = can("inventory.modify");
  const shown = (items.data ?? []).filter(
    (i) => (!area || i.area_id === area) && (!cat || i.category_id === cat),
  );
  const catName = (id: string | null) => meta.cats.find((c) => c.id === id)?.name ?? "";
  const areaName = (id: string | null) => meta.areas.find((a) => a.id === id)?.name ?? "";
  return (
    <>
      <AreaBar
        areas={meta.areas}
        cats={meta.cats}
        area={area}
        cat={cat}
        onArea={setArea}
        onCat={setCat}
        extra={
          edit ? (
            <>
              <button type="button" className="btn sm" onClick={() => setManage(true)}>
                Áreas y categorías
              </button>
              <button
                type="button"
                className="btn primary sm"
                style={{ minHeight: 40 }}
                onClick={() => setForm("new")}
              >
                + Nuevo insumo
              </button>
            </>
          ) : undefined
        }
      />
      <section className="card fillcard">
        <PagedRows
          fixed
          items={shown}
          rowH={48}
          empty={
            <p className="muted">
              {area ? "No hay insumos en esta selección" : "Aún no hay insumos"}
            </p>
          }
          head={
            <tr>
              <th>Insumo</th>
              <th style={{ width: "19%" }}>Área › Categoría</th>
              <th className="r" style={{ width: 104 }}>
                Existencia
              </th>
              <th className="r" style={{ width: 128 }}>
                Mín. / Máx.
              </th>
              <th style={{ width: 64 }}>Estado</th>
              <th style={{ width: 188 }} />
            </tr>
          }
          row={(i) => (
            <>
              <td className="ellipsis">{i.name}</td>
              <td className="small ellipsis">
                {[areaName(i.area_id), catName(i.category_id)].filter(Boolean).join(" › ") || "—"}
              </td>
              <td className="r num">
                {fmt(i.stock)} {i.unit}
              </td>
              <td className="r num small">
                {i.min_stock ? fmt(i.min_stock) : "—"} /{" "}
                {i.max_stock != null ? fmt(i.max_stock) : "—"}
              </td>
              <td>
                {alertOf(i.id) ? (
                  <StatusChip tone={alertOf(i.id) === "bajo" ? "warn" : "bad"} icon="alerta">
                    {alertOf(i.id) === "bajo"
                      ? "Bajo"
                      : alertOf(i.id) === "agotado"
                        ? "Agotado"
                        : alertOf(i.id)}
                  </StatusChip>
                ) : (
                  <StatusChip tone="ok" icon="check">
                    Normal
                  </StatusChip>
                )}
              </td>
              <td className="r">
                {edit && (
                  <span className="row" style={{ justifyContent: "flex-end", gap: 4 }}>
                    <button type="button" className="btn sm" onClick={() => setMove(i)}>
                      Movimiento
                    </button>
                    <button type="button" className="btn sm" onClick={() => setForm(i)}>
                      Editar
                    </button>
                  </span>
                )}
              </td>
            </>
          )}
        />
      </section>
      {move && (
        <MoveSheet
          item={move}
          onClose={() => {
            setMove(null);
            items.reload();
            alerts.reload();
          }}
        />
      )}
      {form && (
        <ItemSheet
          item={form === "new" ? null : form}
          meta={meta}
          onClose={(changed) => {
            setForm(null);
            if (changed) {
              items.reload();
              alerts.reload();
            }
          }}
        />
      )}
      {manage && (
        <AreasSheet
          meta={meta}
          onClose={() => {
            setManage(false);
            meta.reload();
            items.reload();
          }}
        />
      )}
    </>
  );
}

/** Lo que ya llegó al mínimo: cuánto hay, cuánto pedir y a quién. De aquí sale la lista de compras. */
function ReorderTab({ rows, onList }: { rows: Reorder[]; onList: (id: string) => void }) {
  const meta = useInventoryMeta();
  const [area, setArea] = useState<string | null>(null);
  const [cat, setCat] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const shown = rows.filter(
    (r) => (!area || r.area_id === area) && (!cat || r.category_id === cat),
  );
  return (
    <>
      <AreaBar
        areas={meta.areas}
        cats={meta.cats}
        area={area}
        cat={cat}
        onArea={setArea}
        onCat={setCat}
      />
      <section className="card fillcard">
        {err && <p className="err">{err}</p>}
        <PagedRows
          items={shown}
          rowH={52}
          empty={
            <p className="muted">
              Nada por pedir en esta selección. Define el mínimo de cada insumo para recibir el
              aviso.
            </p>
          }
          head={
            <tr>
              <th>Insumo</th>
              <th>Área › Categoría</th>
              <th className="r">Hay</th>
              <th className="r">Mínimo</th>
              <th className="r">Pedir</th>
              <th>Proveedor</th>
            </tr>
          }
          row={(r) => (
            <>
              <td className="ellipsis" style={{ maxWidth: 220 }}>
                <strong>{r.name}</strong>{" "}
                <StatusChip tone={r.level === "agotado" ? "bad" : "warn"} icon="alerta">
                  {r.level === "agotado" ? "Agotado" : "Bajo"}
                </StatusChip>
              </td>
              <td className="small ellipsis" style={{ maxWidth: 190 }}>
                {[r.area, r.category].filter(Boolean).join(" › ") || "—"}
              </td>
              <td className="r num">
                {fmt(r.stock)} {r.unit}
              </td>
              <td className="r num small">{fmt(r.min_stock)}</td>
              <td className="r num">
                <strong>
                  {fmt(r.suggested)} {r.unit}
                </strong>
              </td>
              <td className="small ellipsis" style={{ maxWidth: 150 }}>
                {r.supplier ?? "—"}
              </td>
            </>
          )}
        />
        {can("inventory.modify") && (
          <div className="row spread" style={{ flex: "none" }}>
            <span className="small">
              {shown.length} insumo(s) por pedir{area ? " en esta selección" : ""}
            </span>
            <button
              type="button"
              className="btn primary"
              disabled={shown.length === 0}
              onClick={() =>
                api<{ id: string }>("/api/shopping-lists", {
                  body: { auto: true, areaId: area ?? undefined, categoryId: cat ?? undefined },
                }).then(
                  (r) => onList(r.id),
                  (e) => setErr((e as Error).message),
                )
              }
            >
              Crear lista de compras con esto
            </button>
          </div>
        )}
      </section>
    </>
  );
}

function MoveSheet({ item, onClose }: { item: Item; onClose: () => void }) {
  const [kind, setKind] = useState("entrada");
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const need = kind === "merma" || kind === "ajuste";
  return (
    <div className="sheet-bg" {...backdrop(onClose)}>
      <div className="sheet center" role="dialog" aria-modal="true">
        <h3>
          {item.name} · {fmt(item.stock)} {item.unit}
        </h3>
        <div className="row wrap">
          {["entrada", "salida", "merma", "ajuste"].map((k) => (
            <button
              type="button"
              key={k}
              className={`opt ${kind === k ? "on" : ""}`}
              onClick={() => setKind(k)}
            >
              {k}
            </button>
          ))}
        </div>
        <input
          placeholder={kind === "ajuste" ? "Cantidad (+ o −)" : "Cantidad"}
          inputMode="decimal"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
        />
        {kind === "entrada" && (
          <input
            placeholder="Costo por unidad (centavos)"
            inputMode="decimal"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
        )}
        {need && (
          <input placeholder="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} />
        )}
        {err && <p className="err">{err}</p>}
        <button
          type="button"
          className="btn primary"
          disabled={!toNum(qty) || (need && !reason)}
          onClick={() =>
            api("/api/inventory/movements", {
              body: {
                itemId: item.id,
                kind,
                quantity: toNum(qty),
                unit_cost_cents: kind === "entrada" && cost ? toNum(cost) : undefined,
                reason: reason || undefined,
              },
            }).then(onClose, (e) => setErr((e as Error).message))
          }
        >
          Registrar
        </button>
      </div>
    </div>
  );
}

function Recipes() {
  const products = useLive(() => api<Product[]>("/api/products"), []);
  const items = useLive(() => api<Item[]>("/api/inventory/items"), []);
  const costs = useLive(
    () =>
      api<{ id: string; cost_cents: number; margin_cents: number; margin_pct: number }[]>(
        "/api/inventory/costs",
      ),
    [],
  );
  const [sel, setSel] = useState<Product | null>(null);
  return (
    <section className="card fillcard">
      <PagedRows
        items={products.data ?? []}
        rowH={48}
        head={
          <tr>
            <th>Producto</th>
            <th className="r">Precio</th>
            <th className="r">Costo</th>
            <th className="r">Margen</th>
            <th />
          </tr>
        }
        row={(p) => {
          const c = costs.data?.find((x) => x.id === p.id);
          return (
            <>
              <td>{p.name}</td>
              <td className="r num">{money(p.price_cents)}</td>
              <td className="r num">{c ? money(c.cost_cents) : "—"}</td>
              <td className="r num">{c ? `${c.margin_pct}%` : "—"}</td>
              <td className="r">
                {can("inventory.modify") && (
                  <button type="button" className="btn sm" onClick={() => setSel(p)}>
                    Receta
                  </button>
                )}
              </td>
            </>
          );
        }}
      />
      {sel && (
        <RecipeEditor
          product={sel}
          items={items.data ?? []}
          onClose={() => {
            setSel(null);
            costs.reload();
          }}
        />
      )}
    </section>
  );
}

function RecipeEditor({
  product,
  items,
  onClose,
}: {
  product: Product;
  items: Item[];
  onClose: () => void;
}) {
  const current = useLive(
    () => api<{ item_id: string; quantity: number }[]>(`/api/recipes/${product.id}`),
    [],
    [product.id],
  );
  const [qty, setQty] = useState<Record<string, string> | null>(null);
  const q =
    qty ?? Object.fromEntries((current.data ?? []).map((l) => [l.item_id, String(l.quantity)]));
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="sheet-bg" {...backdrop(onClose)}>
      <div className="sheet center" style={{ height: "min(560px, 100%)" }}>
        <h3>Receta · {product.name}</h3>
        <p className="small">
          Cantidad de cada insumo por unidad vendida. Se descuenta al enviar la comanda.
        </p>
        <PagedRows
          items={items}
          rowH={56}
          row={(i) => (
            <td style={{ padding: 0 }}>
              <div className="row" style={{ height: 56 }}>
                <span className="grow">
                  {i.name} <span className="small">({i.unit})</span>
                </span>
                <input
                  style={{ width: 110 }}
                  inputMode="decimal"
                  placeholder="0"
                  value={q[i.id] ?? ""}
                  onChange={(e) => setQty({ ...q, [i.id]: e.target.value })}
                />
              </div>
            </td>
          )}
        />
        {err && <p className="err">{err}</p>}
        <button
          type="button"
          className="btn primary"
          onClick={() =>
            api(`/api/recipes/${product.id}`, {
              method: "PUT",
              body: {
                lines: Object.entries(q)
                  .filter(([, v]) => toNum(v) > 0)
                  .map(([itemId, v]) => ({ itemId, quantity: toNum(v) })),
              },
            }).then(onClose, (e) => setErr((e as Error).message))
          }
        >
          Guardar receta
        </button>
      </div>
    </div>
  );
}

function Purchases() {
  const suppliers = useLive(() => api<Supplier[]>("/api/suppliers"), []);
  const items = useLive(() => api<Item[]>("/api/inventory/items"), []);
  const pos = useLive(() => api<PO[]>("/api/purchase-orders"), []);
  const [sup, setSup] = useState({ name: "", phone: "" });
  const [supOpen, setSupOpen] = useState(false);
  const [po, setPo] = useState<{ supplierId: string; item: string; qty: string; cost: string }>({
    supplierId: "",
    item: "",
    qty: "",
    cost: "",
  });
  const [err, setErr] = useState<string | null>(null);
  const run = (p: Promise<unknown>, after: () => void) =>
    p.then(
      () => {
        setErr(null);
        after();
      },
      (e) => setErr((e as Error).message),
    );
  const manage = can("purchase.manage");
  return (
    <div className="split">
      <section className="card fillcard">
        <h3>Órdenes de compra</h3>
        {err && <p className="err">{err}</p>}
        <PagedRows
          items={pos.data ?? []}
          rowH={64}
          empty={<p className="muted">Sin órdenes de compra</p>}
          row={(p) => (
            <td style={{ padding: 0 }}>
              <div className="row spread" style={{ height: 64 }}>
                <div style={{ minWidth: 0 }}>
                  <strong>{p.supplier}</strong> <span className="tag">{p.status}</span>
                  <div className="small ellipsis">
                    {p.lines.map((l) => `${fmt(l.quantity)} ${l.unit} ${l.item}`).join(" · ")}
                  </div>
                </div>
                <div className="row">
                  <span className="num">{money(p.total_cents)}</span>
                  {manage && p.status === "borrador" && (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() =>
                        run(api(`/api/purchase-orders/${p.id}/send`, { body: {} }), pos.reload)
                      }
                    >
                      Enviar
                    </button>
                  )}
                  {manage && (p.status === "borrador" || p.status === "enviada") && (
                    <button
                      type="button"
                      className="btn primary sm"
                      style={{ minHeight: 44 }}
                      onClick={() =>
                        run(api(`/api/purchase-orders/${p.id}/receive`, { body: {} }), () => {
                          pos.reload();
                          items.reload();
                        })
                      }
                    >
                      Recibir
                    </button>
                  )}
                </div>
              </div>
            </td>
          )}
        />
      </section>
      {manage && (
        <section className="card col" style={{ width: 360, flex: "none" }}>
          <h3>Nueva compra (1 renglón)</h3>
          <select
            value={po.supplierId}
            onChange={(e) => setPo({ ...po, supplierId: e.target.value })}
          >
            <option value="">Proveedor…</option>
            {suppliers.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select value={po.item} onChange={(e) => setPo({ ...po, item: e.target.value })}>
            <option value="">Insumo…</option>
            {items.data?.map((it) => (
              <option key={it.id} value={it.id}>
                {it.name}
              </option>
            ))}
          </select>
          <div className="row">
            <input
              className="grow"
              placeholder="Cantidad"
              inputMode="decimal"
              value={po.qty}
              onChange={(e) => setPo({ ...po, qty: e.target.value })}
            />
            <input
              className="grow"
              placeholder="Costo (¢)"
              inputMode="decimal"
              value={po.cost}
              onChange={(e) => setPo({ ...po, cost: e.target.value })}
            />
          </div>
          <button
            type="button"
            className="btn primary"
            disabled={!po.supplierId || !po.item || !toNum(po.qty)}
            onClick={() =>
              run(
                api("/api/purchase-orders", {
                  body: {
                    supplierId: po.supplierId,
                    lines: [
                      { itemId: po.item, quantity: toNum(po.qty), unit_cost_cents: toNum(po.cost) },
                    ],
                  },
                }),
                () => {
                  setPo({ supplierId: po.supplierId, item: "", qty: "", cost: "" });
                  pos.reload();
                },
              )
            }
          >
            Crear orden
          </button>
          <button type="button" className="btn" onClick={() => setSupOpen(true)}>
            + Proveedor nuevo
          </button>
        </section>
      )}
      {supOpen && (
        <div className="sheet-bg" {...backdrop(() => setSupOpen(false))}>
          <div className="sheet center" role="dialog" aria-modal="true">
            <h3>Proveedor nuevo</h3>
            <input
              autoFocus
              placeholder="Nombre"
              value={sup.name}
              onChange={(e) => setSup({ ...sup, name: e.target.value })}
            />
            <input
              placeholder="Teléfono"
              value={sup.phone}
              onChange={(e) => setSup({ ...sup, phone: e.target.value })}
            />
            <button
              type="button"
              className="btn primary"
              disabled={!sup.name}
              onClick={() =>
                run(
                  api("/api/suppliers", { body: { name: sup.name, phone: sup.phone || null } }),
                  () => {
                    setSup({ name: "", phone: "" });
                    setSupOpen(false);
                    suppliers.reload();
                  },
                )
              }
            >
              Agregar proveedor
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
