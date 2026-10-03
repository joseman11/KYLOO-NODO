import { useEffect, useMemo, useState } from "react";
import { backdrop } from "../sheet";
import { money, photoSrc } from "../api";
import { flattenCategories, withDescendants, type Category } from "../categories";
import { PagedGrid, PagedRows } from "../fit";
import { ModifierSheet } from "./Order";

interface Product {
  id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  price_cents: number;
  availability: string;
  modifier_group_ids: string[];
  photo: string | null;
}
interface Group {
  id: string;
  name: string;
  required: number;
  multiple: number;
  max_select: number | null;
  modifiers: { id: string; name: string; price_cents: number }[];
}
interface Menu {
  table: { number: string };
  can_order: boolean;
  categories: Category[];
  products: Product[];
  groups: Group[];
}
interface Line {
  key: string;
  product: Product;
  quantity: number;
  modifierIds: string[];
  labels: string[];
  unit: number;
}

/** Menú público del QR de la mesa: sin inicio de sesión, el enlace lleva un token firmado. */
async function pub<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message ?? data?.error ?? "Error");
  return data as T;
}

export function PublicMenu() {
  const t = new URLSearchParams(location.search).get("t") ?? "";
  const [menu, setMenu] = useState<Menu | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cat, setCat] = useState<string | null>(null);
  const [cart, setCart] = useState<Line[]>([]);
  const [picking, setPicking] = useState<Product | null>(null);
  const [review, setReview] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () =>
    pub<Menu>(`/api/public/menu?t=${encodeURIComponent(t)}`).then(setMenu, () =>
      setError("Este código QR no es válido. Pide ayuda a tu mesero."),
    );
  // biome-ignore lint/correctness/useExhaustiveDependencies: se carga una sola vez al abrir
  useEffect(() => {
    void load();
  }, []);

  // Categorías principales arriba; al elegir una, el producto puede estar en cualquiera de sus subcategorías
  const top = useMemo(
    () => flattenCategories(menu?.categories ?? []).filter((c) => c.depth === 0),
    [menu],
  );
  const products = useMemo(() => {
    const ids = cat && menu ? withDescendants(menu.categories, cat) : null;
    return (menu?.products ?? []).filter(
      (p) => !ids || (p.category_id !== null && ids.has(p.category_id)),
    );
  }, [menu, cat]);
  const total = cart.reduce((s, l) => s + l.unit * l.quantity, 0);
  const count = cart.reduce((s, l) => s + l.quantity, 0);

  const add = (p: Product, ids: string[] = [], labels: string[] = [], extra = 0) => {
    const key = `${p.id}|${[...ids].sort().join(",")}`;
    setCart((c) =>
      c.find((l) => l.key === key)
        ? c.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l))
        : [
            ...c,
            { key, product: p, quantity: 1, modifierIds: ids, labels, unit: p.price_cents + extra },
          ],
    );
  };
  const call = (reason: "mesero" | "cuenta") =>
    pub("/api/public/call", { t, reason }).then(
      () => setMsg(reason === "mesero" ? "Ya avisamos a tu mesero" : "Pedimos tu cuenta"),
      (e) => setMsg((e as Error).message),
    );
  const order = () =>
    pub("/api/public/order", {
      t,
      items: cart.map((l) => ({
        productId: l.product.id,
        quantity: l.quantity,
        modifierIds: l.modifierIds,
      })),
    }).then(
      () => {
        setCart([]);
        setReview(false);
        setMsg("¡Pedido enviado a cocina!");
        void load();
      },
      (e) => setMsg((e as Error).message),
    );

  if (error)
    return (
      <div className="login">
        <h2>Menú</h2>
        <p className="err">{error}</p>
      </div>
    );
  if (!menu)
    return (
      <div className="login">
        <p className="muted">Cargando menú…</p>
      </div>
    );

  return (
    <div
      style={{
        height: "100%",
        maxWidth: 640,
        margin: "0 auto",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div className="row spread" style={{ flex: "none" }}>
        <div>
          <h2>Menú · Mesa {menu.table.number}</h2>
        </div>
        <div className="row">
          <button type="button" className="btn sm" onClick={() => call("mesero")}>
            Mesero
          </button>
          <button type="button" className="btn sm" onClick={() => call("cuenta")}>
            Cuenta
          </button>
        </div>
      </div>
      {(msg || !menu.can_order) && (
        <p className="small" style={{ color: "var(--color-ink)", flex: "none" }}>
          {msg ?? "Tu mesero abrirá tu mesa para que puedas ordenar desde aquí."}
        </p>
      )}
      <div className="chips">
        <button
          type="button"
          className={`chip ${cat === null ? "on" : ""}`}
          onClick={() => setCat(null)}
        >
          Todo
        </button>
        {top.map((c) => (
          <button
            type="button"
            key={c.id}
            className={`chip ${cat === c.id ? "on" : ""}`}
            onClick={() => setCat(c.id)}
          >
            {c.name}
          </button>
        ))}
      </div>
      <PagedGrid
        items={products}
        minW={280}
        minH={76}
        gap={8}
        render={(p) => (
          <div className="card row spread" style={{ height: "100%", padding: "8px 12px", gap: 10 }}>
            {photoSrc(p.photo) && (
              <img
                src={photoSrc(p.photo)!}
                alt=""
                style={{
                  width: 64,
                  height: "100%",
                  maxHeight: 76,
                  objectFit: "cover",
                  borderRadius: 8,
                  flex: "none",
                }}
              />
            )}
            <div className="grow" style={{ minWidth: 0 }}>
              <strong className="ellipsis" style={{ display: "block" }}>
                {p.name}
              </strong>
              {p.description && <div className="small ellipsis">{p.description}</div>}
              <div className="num">
                {p.availability === "disponible" ? money(p.price_cents) : "Agotado"}
              </div>
            </div>
            {menu.can_order && (
              <button
                type="button"
                className="btn primary"
                style={{ minHeight: 48 }}
                disabled={p.availability !== "disponible"}
                onClick={() => (p.modifier_group_ids.length ? setPicking(p) : add(p))}
              >
                +
              </button>
            )}
          </div>
        )}
      />
      {count > 0 && (
        <button
          type="button"
          className="btn primary"
          style={{ flex: "none" }}
          onClick={() => setReview(true)}
        >
          Ver pedido · {count} · {money(total)}
        </button>
      )}

      {review && (
        <div className="sheet-bg" {...backdrop(() => setReview(false))}>
          <div className="sheet center" style={{ height: "min(520px, 100%)" }}>
            <h3>Tu pedido</h3>
            <PagedRows
              items={cart}
              rowH={56}
              row={(l) => (
                <td style={{ padding: 0 }}>
                  <div className="row spread" style={{ height: 56 }}>
                    <span className="ellipsis">
                      {l.quantity} × {l.product.name}
                      <div className="small ellipsis">{l.labels.join(", ")}</div>
                    </span>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => setCart(cart.filter((x) => x.key !== l.key))}
                    >
                      Quitar
                    </button>
                  </div>
                </td>
              )}
            />
            <button type="button" className="btn primary" onClick={order}>
              Enviar pedido · {money(total)}
            </button>
          </div>
        </div>
      )}
      {picking && (
        <ModifierSheet
          product={picking}
          groups={menu.groups.filter((g) => picking.modifier_group_ids.includes(g.id))}
          onCancel={() => setPicking(null)}
          onDone={(ids, labels, extra) => {
            add(picking, ids, labels, extra);
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}
