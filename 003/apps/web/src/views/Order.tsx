import { useEffect, useMemo, useState } from "react";
import {
  ApiError,
  api,
  can,
  money,
  photoSrc,
  requestBillOffline,
  sendOrder,
  useLive,
} from "../api";
import { flattenCategories, withDescendants, type Category } from "../categories";
import { Icon } from "../icons";
import { PagedGrid, PagedRows } from "../fit";
import { NumPad } from "../numpad";
import { CustomerSheet, DiscountSheet } from "./OrderSheets";

interface Product {
  id: string;
  name: string;
  price_cents: number;
  category_id: string | null;
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
interface Item {
  id: string;
  name: string;
  quantity: number;
  unit_price_cents: number;
  modifiers: string[];
  note: string | null;
  course: string | null;
  seat: number | null;
  held: number;
  status: string;
}
interface Discount {
  id: string;
  kind: string;
  amount_cents: number;
  reason: string | null;
}
interface Account {
  id: string;
  table_id: string | null;
  table_number: string;
  waiter: string;
  status: string;
  kind: string;
  guests: number;
  opened_at: number;
  items: Item[];
  discounts: Discount[];
  subtotal_cents: number;
  discount_cents: number;
  delivery_fee_cents: number;
  service_charge_cents: number;
  service_waived: number;
  total_cents: number;
  paid_cents: number;
  balance_cents: number;
}
interface CartLine {
  key: string;
  product: Product;
  quantity: number;
  modifierIds: string[];
  modLabels: string[];
  unit: number;
  note: string;
  seat: number | null;
}
/** Separador de la comanda ("Entradas", "Plato fuerte"…): lo que se agrega después pertenece a ese tiempo. `hold`: no sale a cocina hasta mandarlo. */
interface CartSep {
  key: string;
  sep: string;
  hold: boolean;
}
type CartEntry = CartLine | CartSep;
const isSep = (e: CartEntry): e is CartSep => "sep" in e;
const isLine = (e: CartEntry): e is CartLine => !("sep" in e);

type Row =
  | { t: "cart"; l: CartLine }
  | { t: "sep"; s: CartSep }
  | { t: "sent"; i: Item }
  | { t: "disc"; d: Discount }
  | { t: "fee"; label: string; cents: number };

const REASONS = [
  "Error de captura",
  "Cliente canceló",
  "Producto agotado",
  "Error de cocina",
  "Otro",
];
type Menu =
  | null
  | "transfer"
  | "move"
  | "split"
  | "merge"
  | "discount"
  | "customer"
  | "fire"
  | "guests"
  | "qty";

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const FAV = "__fav__";

/**
 * Comandero: encabezado con mesa, mesero y comensales; a la izquierda la cuenta (cantidad, descripción, importe)
 * con asientos y envío; a la derecha buscador, favoritos, categorías y productos con foto; abajo la barra de funciones.
 * Todo cabe en pantalla, sin desplazamiento.
 */
export function Order({ accountId, onBack }: { accountId: string; onBack: () => void }) {
  const catalog = useLive(
    async () => {
      const [products, categories, groups] = await Promise.all([
        api<Product[]>("/api/products"),
        api<Category[]>("/api/categories"),
        api<Group[]>("/api/modifier-groups"),
      ]);
      return { products, categories, groups };
    },
    ["product.updated"],
    [],
    "catalog",
  );
  const account = useLive(
    () => api<Account>(`/api/accounts/${accountId}`),
    ["order.created", "order.updated", "table.updated", "ticket.updated"],
    [accountId],
    `account.${accountId}`,
  );
  const favs = useLive(
    () => api<{ product_id: string; uses: number; pinned: number }[]>("/api/favorites"),
    ["order.created"],
    [],
    "favorites",
  );

  const [cat, setCat] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [cart, setCart] = useState<CartEntry[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [mult, setMult] = useState(1);
  const [seat, setSeat] = useState<number | null>(null);
  const [showPhotos, setShowPhotos] = useState(() => {
    try {
      return localStorage.getItem("003.photos") !== "0";
    } catch {
      return true;
    }
  });
  const [picking, setPicking] = useState<Product | null>(null);
  const [cancelItem, setCancelItem] = useState<Item | null>(null);
  const [noteFor, setNoteFor] = useState<CartLine | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [separating, setSeparating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const a = account.data;
  const closed = a?.status === "cerrada";
  const allCats = catalog.data?.categories ?? [];
  const tree = useMemo(() => flattenCategories(allCats), [allCats]);
  const selected = tree.find((c) => c.id === cat) ?? null;
  const hasKids = (id: string) => allCats.some((c) => c.parent_id === id);
  const subRow = selected
    ? hasKids(selected.id)
      ? tree.filter((c) => c.parent_id === selected.id)
      : selected.parent_id
        ? tree.filter((c) => c.parent_id === selected.parent_id)
        : []
    : [];
  const topId = (() => {
    let c = selected;
    while (c?.parent_id) c = tree.find((x) => x.id === c!.parent_id) ?? null;
    return c?.id ?? null;
  })();

  const products = useMemo(() => {
    const all = catalog.data?.products ?? [];
    if (query.trim()) {
      const q = norm(query.trim());
      return all.filter((p) => norm(p.name).includes(q));
    }
    if (cat === FAV) {
      const order = (favs.data ?? []).map((f) => f.product_id);
      return order.map((id) => all.find((p) => p.id === id)).filter((p): p is Product => !!p);
    }
    const ids = cat ? withDescendants(allCats, cat) : null;
    return all.filter((p) => !ids || (p.category_id !== null && ids.has(p.category_id)));
  }, [catalog.data, cat, allCats, query, favs.data]);
  const anyPhoto = showPhotos && (catalog.data?.products ?? []).some((p) => p.photo);

  // Columna de categorías: Todo, Favoritos, las principales y, bajo la elegida, sus subcategorías
  const branch = topId ? withDescendants(allCats, topId) : new Set<string>();
  const catRows: { id: string | null; label: string; on: boolean; sub: boolean }[] = [
    { id: null, label: "Todo", on: cat === null && !query, sub: false },
    ...((favs.data ?? []).length > 0
      ? [{ id: FAV, label: "Favoritos", on: cat === FAV && !query, sub: false }]
      : []),
    ...tree.flatMap((c) => {
      if (c.depth === 0)
        return [{ id: c.id, label: c.name, on: cat === c.id && !query, sub: false }];
      return topId && branch.has(c.id) && cat !== FAV
        ? [{ id: c.id, label: c.name, on: cat === c.id && !query, sub: true }]
        : [];
    }),
  ];

  const lines = cart.filter(isLine);
  const cartTotal = lines.reduce((s, l) => s + l.unit * l.quantity, 0);
  const heldCourses = [
    ...new Set(
      (a?.items ?? [])
        .filter((i) => i.held && i.status === "activo")
        .map((i) => i.course ?? "Tiempo"),
    ),
  ];
  const guests = a?.guests ?? 1;

  const rows: Row[] = [
    ...cart.map((e): Row => (isSep(e) ? { t: "sep", s: e } : { t: "cart", l: e })),
    ...(a?.items.filter((i) => i.status === "activo").map((i): Row => ({ t: "sent", i })) ?? []),
    ...(a?.discounts.map((d): Row => ({ t: "disc", d })) ?? []),
    ...(a && a.service_charge_cents > 0
      ? [{ t: "fee", label: "Cargo por servicio", cents: a.service_charge_cents } as Row]
      : []),
    ...(a && a.delivery_fee_cents > 0
      ? [{ t: "fee", label: "Envío", cents: a.delivery_fee_cents } as Row]
      : []),
  ];

  const addProduct = (
    p: Product,
    modifierIds: string[] = [],
    modLabels: string[] = [],
    extra = 0,
  ) => {
    setCart((c) => {
      // Solo se junta con una línea igual del mismo tiempo y asiento
      const lastSep = [...c].reverse().find(isSep)?.key ?? "";
      const key = `${p.id}|${modifierIds.slice().sort().join(",")}|${lastSep}|${seat ?? ""}`;
      const found = c.find((l) => isLine(l) && l.key === key);
      return found
        ? c.map((l) => (isLine(l) && l.key === key ? { ...l, quantity: l.quantity + mult } : l))
        : [
            ...c,
            {
              key,
              product: p,
              quantity: mult,
              modifierIds,
              modLabels,
              unit: p.price_cents + extra,
              note: "",
              seat,
            },
          ];
    });
    setMult(1);
  };
  const step = (key: string, d: number) =>
    setCart((c) =>
      c
        .map((l) => (isLine(l) && l.key === key ? { ...l, quantity: l.quantity + d } : l))
        .filter((l) => isSep(l) || l.quantity > 0),
    );
  const addSeparator = (label: string, hold: boolean) => {
    setCart((c) => [...c, { key: `sep-${Date.now()}`, sep: label, hold }]);
    setSeparating(false);
  };

  const send = async () => {
    setBusy(true);
    setMsg(null);
    try {
      // Cada producto lleva el nombre del último separador anterior a él (su "tiempo") y si ese tiempo queda retenido
      let course: string | undefined;
      let hold = false;
      const items: {
        productId: string;
        quantity: number;
        modifierIds: string[];
        note?: string;
        course?: string;
        seat?: number;
        hold?: boolean;
      }[] = [];
      for (const e of cart) {
        if (isSep(e)) {
          course = e.sep;
          hold = e.hold;
        } else
          items.push({
            productId: e.product.id,
            quantity: e.quantity,
            modifierIds: e.modifierIds,
            note: e.note || undefined,
            course,
            seat: e.seat ?? undefined,
            hold: hold || undefined,
          });
      }
      const r = await sendOrder(accountId, items);
      setCart([]);
      setMsg(
        r.queued
          ? "Sin conexión: comanda guardada, se enviará al reconectar"
          : hold
            ? "Enviado: el tiempo retenido espera para salir"
            : "Comanda enviada",
      );
      account.reload();
      favs.reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const requestBill = async () => {
    try {
      const r = await requestBillOffline(accountId);
      setMsg(
        r.queued ? "Sin conexión: la cuenta se pedirá al reconectar" : "Cuenta solicitada a caja",
      );
      account.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const hasTable = !!a?.table_id;
  const fn: { label: string; show: boolean; run: () => void; off?: boolean; ember?: boolean }[] = [
    {
      label: heldCourses.length ? `Mandar tiempo (${heldCourses.length})` : "Mandar tiempo",
      show: heldCourses.length > 0,
      run: () => setMenu("fire"),
      ember: true,
    },
    {
      label: a?.status === "pago_solicitado" ? "Cuenta ✓" : "Cuenta",
      show: true,
      run: requestBill,
      off: !a || a.items.length === 0 || a.status !== "abierta",
    },
    { label: "Separador", show: true, run: () => setSeparating(true), off: !!closed },
    { label: "Descuento", show: true, run: () => setMenu("discount") },
    { label: "Cliente", show: true, run: () => setMenu("customer") },
    { label: "Dividir", show: can("bill.split"), run: () => setMenu("split") },
    { label: "Juntar mesas", show: can("bill.merge") && hasTable, run: () => setMenu("merge") },
    { label: "Mover", show: can("table.change") && hasTable, run: () => setMenu("move") },
    {
      label: "Transferir",
      show: can("table.transfer") && hasTable,
      run: () => setMenu("transfer"),
    },
  ];

  const selRow =
    rows.find((r) => (r.t === "cart" && r.l.key === sel) || (r.t === "sent" && r.i.id === sel)) ??
    null;
  const mins = a ? Math.max(0, Math.floor((Date.now() - a.opened_at) / 60000)) : 0;
  const seats = Array.from({ length: Math.min(12, Math.max(2, guests)) }, (_, i) => i + 1);

  return (
    <div className="view">
      {/* Encabezado: mesa, mesero, comensales y tiempo */}
      <div className="comanda-head">
        <button className="btn sm" onClick={onBack}>
          ← Mesas
        </button>
        <h2>
          {a && !a.table_id ? "Pedido" : "Mesa"} {a?.table_number ?? "…"}
        </h2>
        <span className="small">{a?.waiter}</span>
        <button
          className="chip"
          style={{ minHeight: 36 }}
          disabled={!!closed || !a}
          onClick={() => setMenu("guests")}
        >
          <Icon name="personas" size={16} /> {guests} {guests === 1 ? "persona" : "personas"} ✎
        </button>
        <span className="small">abierta hace {mins} min</span>
        <span className="grow" />
        <button
          className={`chip ${showPhotos ? "on" : ""}`}
          style={{ minHeight: 36 }}
          onClick={() => {
            const v = !showPhotos;
            setShowPhotos(v);
            try {
              localStorage.setItem("003.photos", v ? "1" : "0");
            } catch {
              /* ignorar */
            }
          }}
        >
          <Icon name="camara" size={16} /> Fotos
        </button>
      </div>

      <div className="split">
        {/* Cuenta */}
        <section
          className="card fillcard"
          style={{ width: "clamp(340px, 36vw, 410px)", flex: "none", padding: 10, gap: 6 }}
        >
          <div
            className="row small"
            style={{ flex: "none", padding: "0 8px", justifyContent: "space-between" }}
          >
            <span style={{ width: 30, textAlign: "right" }}>Cant.</span>
            <span className="grow" style={{ paddingLeft: 8 }}>
              Descripción
            </span>
            <span>Importe</span>
          </div>
          <PagedRows
            items={rows}
            rowH={52}
            empty={
              <p className="muted" style={{ padding: 16 }}>
                Toca un producto para agregarlo
              </p>
            }
            row={(r) => (
              <td style={{ padding: 0 }}>
                {r.t === "cart" && (
                  <button
                    className={`tk ${sel === r.l.key ? "sel" : ""}`}
                    style={{ background: sel === r.l.key ? undefined : "#fff7f2" }}
                    onClick={() => setSel(r.l.key)}
                  >
                    <span className="q num">{r.l.quantity}</span>
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="ellipsis" style={{ display: "block", fontWeight: 600 }}>
                        {r.l.product.name}
                        {r.l.seat ? ` · A${r.l.seat}` : ""}
                      </span>
                      <span className="small ellipsis" style={{ display: "block" }}>
                        {r.l.note ? `» ${r.l.note}` : r.l.modLabels.join(", ") || "por enviar"}
                      </span>
                    </span>
                    <span className="num">{money(r.l.unit * r.l.quantity)}</span>
                  </button>
                )}
                {r.t === "sep" && (
                  <div className="tk sepline">
                    <span
                      className="grow ellipsis"
                      style={{
                        textAlign: "center",
                        fontWeight: 600,
                        letterSpacing: "0.04em",
                        textTransform: "uppercase",
                      }}
                    >
                      ── {r.s.sep}
                      {r.s.hold ? " · retenido" : ""} ──
                    </span>
                    <button
                      className="btn ghost sm"
                      style={{ color: "#fff" }}
                      aria-label="Quitar separador"
                      onClick={() => setCart((c) => c.filter((x) => x.key !== r.s.key))}
                    >
                      ✕
                    </button>
                  </div>
                )}
                {r.t === "sent" && (
                  <button
                    className={`tk ${sel === r.i.id ? "sel" : ""}`}
                    onClick={() => setSel(r.i.id)}
                  >
                    <span className="q num">{r.i.quantity}</span>
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="ellipsis" style={{ display: "block" }}>
                        {r.i.name}
                        {r.i.seat ? ` · A${r.i.seat}` : ""}
                      </span>
                      {(r.i.modifiers.length > 0 || !!r.i.note || !!r.i.course || !!r.i.held) && (
                        <span className="small ellipsis" style={{ display: "block" }}>
                          {[
                            r.i.held ? "RETENIDO" : "",
                            r.i.course ? `[${r.i.course}]` : "",
                            ...r.i.modifiers,
                            r.i.note ? `» ${r.i.note}` : "",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      )}
                    </span>
                    <span className="num">{money(r.i.quantity * r.i.unit_price_cents)}</span>
                  </button>
                )}
                {r.t === "disc" && (
                  <div className="tk" style={{ cursor: "default" }}>
                    <span className="q" />
                    <span className="grow small ellipsis">Descuento · {r.d.reason}</span>
                    <span className="num">−{money(r.d.amount_cents)}</span>
                    {can("discount.apply") && !closed && (
                      <button
                        className="btn ghost sm"
                        aria-label="Quitar descuento"
                        onClick={() =>
                          api(`/api/accounts/${accountId}/discounts/${r.d.id}`, {
                            method: "DELETE",
                          }).then(() => account.reload())
                        }
                      >
                        ✕
                      </button>
                    )}
                  </div>
                )}
                {r.t === "fee" && (
                  <div className="tk" style={{ cursor: "default" }}>
                    <span className="q" />
                    <span className="grow small">{r.label}</span>
                    <span className="num">{money(r.cents)}</span>
                    {r.label === "Cargo por servicio" && can("discount.apply") && !closed && (
                      <button
                        className="btn ghost sm"
                        title="Dispensar el cargo por servicio"
                        onClick={() =>
                          api(`/api/accounts/${accountId}/service-charge`, {
                            body: { waive: true },
                          }).then(() => account.reload())
                        }
                      >
                        ✕
                      </button>
                    )}
                  </div>
                )}
              </td>
            )}
          />

          {/* Acciones del renglón elegido */}
          <div className="row" style={{ flex: "none", minHeight: 44 }}>
            {selRow?.t === "cart" && (
              <>
                <div className="stepper">
                  <button className="btn" onClick={() => step(selRow.l.key, -1)}>
                    −
                  </button>
                  <span
                    className="num"
                    style={{ minWidth: 26, textAlign: "center", fontWeight: 600 }}
                  >
                    {selRow.l.quantity}
                  </span>
                  <button className="btn" onClick={() => step(selRow.l.key, 1)}>
                    +
                  </button>
                </div>
                <button className="btn grow" onClick={() => setNoteFor(selRow.l)}>
                  ✎ Nota
                </button>
                <button
                  className="btn ghost"
                  onClick={() => {
                    setCart((c) => c.filter((x) => x.key !== selRow.l.key));
                    setSel(null);
                  }}
                >
                  Quitar
                </button>
              </>
            )}
            {selRow?.t === "sent" && !closed && (
              <>
                <span className="small grow ellipsis">
                  {selRow.i.quantity} × {selRow.i.name}
                </span>
                {can("item.cancel") && (
                  <button className="btn" onClick={() => setCancelItem(selRow.i)}>
                    Cancelar producto
                  </button>
                )}
              </>
            )}
            {!selRow && <span className="small">Toca un renglón para editarlo</span>}
          </div>

          {msg && (
            <p className="small" style={{ color: "var(--color-ink)", flex: "none" }}>
              {msg}
            </p>
          )}
          <div className="row spread" style={{ alignItems: "baseline", flex: "none" }}>
            <span className="small">
              {lines.length > 0
                ? `Por enviar ${money(cartTotal)}`
                : a && a.paid_cents > 0
                  ? `Pagado ${money(a.paid_cents)}`
                  : "Total"}
            </span>
            <strong className="num" style={{ fontSize: 28 }}>
              {a ? money(a.total_cents + cartTotal) : ""}
            </strong>
          </div>
          <button
            className="btn primary block"
            style={{ flex: "none" }}
            disabled={lines.length === 0 || busy || !!closed}
            onClick={send}
          >
            Enviar comanda
          </button>
        </section>

        {/* Productos: categorías en columna a la izquierda, productos al centro, funciones abajo */}
        <section className="pane grow" style={{ gap: 6 }}>
          {/* Cantidad y asiento */}
          <div className="row" style={{ flex: "none", gap: 4, flexWrap: "wrap" }}>
            <span className="small">Cant.</span>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                className={`chip ${mult === n ? "on" : ""}`}
                style={{ minHeight: 38, padding: "0 10px" }}
                onClick={() => setMult(n)}
              >
                ×{n}
              </button>
            ))}
            <button
              className={`chip ${mult > 5 ? "on" : ""}`}
              style={{ minHeight: 38, padding: "0 10px" }}
              onClick={() => setMenu("qty")}
            >
              {mult > 5 ? `×${mult}` : "…"}
            </button>
            <span className="small" style={{ marginLeft: 8 }}>
              Asiento
            </span>
            <button
              className={`chip ${seat === null ? "on" : ""}`}
              style={{ minHeight: 38, padding: "0 10px" }}
              onClick={() => setSeat(null)}
            >
              Todos
            </button>
            {seats.map((n) => (
              <button
                key={n}
                className={`chip ${seat === n ? "on" : ""}`}
                style={{ minHeight: 38, padding: "0 10px" }}
                onClick={() => setSeat(n)}
              >
                {n}
              </button>
            ))}
          </div>

          <div className="split" style={{ gap: 8 }}>
            {/* Buscador, favoritos y categorías (con sus subcategorías debajo de la elegida) */}
            <div className="pane" style={{ width: 150, flex: "none", gap: 6 }}>
              <div className="row" style={{ flex: "none", position: "relative" }}>
                <input
                  placeholder="Buscar…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  style={{ minHeight: 40, width: "100%", paddingLeft: 32 }}
                />
                <span
                  style={{
                    position: "absolute",
                    left: 9,
                    top: 10,
                    color: "var(--color-steel)",
                    pointerEvents: "none",
                  }}
                >
                  <Icon name="buscar" size={18} />
                </span>
              </div>
              <PagedRows
                items={catRows}
                rowH={48}
                fixed
                row={(r) => (
                  <td style={{ padding: 0 }}>
                    <button
                      className={`opt ${r.on ? "on" : ""}`}
                      style={{
                        width: "100%",
                        height: 44,
                        textAlign: "left",
                        padding: r.sub ? "0 8px 0 18px" : "0 10px",
                        fontSize: r.sub ? 14 : 15,
                        fontWeight: r.sub ? 500 : 600,
                        background: r.on ? undefined : r.sub ? "var(--color-fog)" : "#fff",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                      onClick={() => {
                        setCat(r.id);
                        setQuery("");
                      }}
                    >
                      {r.id === FAV && <Icon name="estrella" size={15} />}
                      <span className="ellipsis">{r.label}</span>
                    </button>
                  </td>
                )}
              />
            </div>

            <PagedGrid
              items={products}
              minW={anyPhoto ? 150 : 140}
              minH={anyPhoto ? 128 : 76}
              empty={
                <p className="muted">
                  {query ? "Ningún producto coincide con la búsqueda" : "Sin productos"}
                </p>
              }
              render={(p) => {
                const src = showPhotos ? photoSrc(p.photo) : null;
                const unavailable = p.availability !== "disponible" || !!closed;
                return (
                  <button
                    className={`product ${src ? "pic" : ""}`}
                    disabled={unavailable}
                    onClick={() => (p.modifier_group_ids.length ? setPicking(p) : addProduct(p))}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      void api(`/api/favorites/${p.id}/pin`, {
                        body: {
                          pinned: !(favs.data ?? []).find((f) => f.product_id === p.id)?.pinned,
                        },
                      }).then(() => favs.reload());
                    }}
                  >
                    {src && (
                      <div
                        className="ph"
                        style={{ backgroundImage: `url(${src})`, opacity: unavailable ? 0.4 : 1 }}
                      />
                    )}
                    <div
                      className={src ? "pt" : ""}
                      style={src ? undefined : { display: "contents" }}
                    >
                      <span style={{ fontWeight: 600 }}>{p.name}</span>
                      <span className="small num">
                        {p.availability !== "disponible" ? "Agotado" : money(p.price_cents)}
                      </span>
                    </div>
                  </button>
                );
              }}
            />
          </div>

          <div className="row" style={{ flex: "none", flexWrap: "wrap", gap: 6 }}>
            {fn
              .filter((f) => f.show)
              .map((f) => (
                <button
                  key={f.label}
                  className={`btn ${f.ember ? "primary" : ""}`}
                  style={{
                    minHeight: 46,
                    flex: "1 1 88px",
                    whiteSpace: "nowrap",
                    padding: "6px 4px",
                  }}
                  disabled={f.off}
                  onClick={f.run}
                >
                  {f.label}
                </button>
              ))}
          </div>
        </section>
      </div>

      {picking && (
        <ModifierSheet
          product={picking}
          groups={(catalog.data?.groups ?? []).filter((g) =>
            picking.modifier_group_ids.includes(g.id),
          )}
          onCancel={() => setPicking(null)}
          onDone={(ids, labels, extra) => {
            addProduct(picking, ids, labels, extra);
            setPicking(null);
          }}
        />
      )}
      {noteFor && (
        <NoteSheet
          line={noteFor}
          onSave={(note) => {
            setCart((c) => c.map((l) => (isLine(l) && l.key === noteFor.key ? { ...l, note } : l)));
            setNoteFor(null);
          }}
          onClose={() => setNoteFor(null)}
        />
      )}
      {separating && <SeparatorSheet onPick={addSeparator} onClose={() => setSeparating(false)} />}
      {cancelItem && (
        <CancelSheet
          item={cancelItem}
          onClose={() => {
            setCancelItem(null);
            setSel(null);
            account.reload();
          }}
        />
      )}
      {menu === "discount" && a && (
        <DiscountSheet
          accountId={accountId}
          subtotalCents={a.subtotal_cents}
          onClose={() => {
            setMenu(null);
            account.reload();
          }}
        />
      )}
      {menu === "customer" && <CustomerSheet accountId={accountId} onClose={() => setMenu(null)} />}
      {(menu === "transfer" || menu === "move") && a && (
        <MoveSheet
          kind={menu}
          accountId={accountId}
          onClose={() => {
            setMenu(null);
            account.reload();
          }}
        />
      )}
      {menu === "split" && a && (
        <SplitSheet
          account={a}
          onClose={() => {
            setMenu(null);
            account.reload();
          }}
        />
      )}
      {menu === "merge" && a && (
        <MergeSheet
          account={a}
          onClose={() => {
            setMenu(null);
            account.reload();
          }}
        />
      )}
      {menu === "fire" && (
        <FireSheet
          accountId={accountId}
          courses={heldCourses}
          onClose={() => {
            setMenu(null);
            account.reload();
          }}
        />
      )}
      {menu === "guests" && (
        <GuestsSheet
          accountId={accountId}
          current={guests}
          onClose={() => {
            setMenu(null);
            account.reload();
          }}
        />
      )}
      {menu === "qty" && (
        <QtySheet
          onPick={(n) => {
            setMult(n);
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

const NOTES = [
  "Sin cebolla",
  "Sin hielo",
  "Poco picante",
  "Extra salsa",
  "Para llevar",
  "Preparar después",
];
const COURSES = [
  "Para empezar",
  "Entradas",
  "Plato fuerte",
  "Postre",
  "Bebidas",
  "Tiempo 2",
  "Tiempo 3",
  "Para llevar",
];

function NoteSheet({
  line,
  onSave,
  onClose,
}: {
  line: CartLine;
  onSave: (n: string) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState(line.note);
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet center" onClick={(e) => e.stopPropagation()}>
        <h3>Nota · {line.product.name}</h3>
        <div className="row wrap">
          {NOTES.map((n) => (
            <button key={n} className="opt" onClick={() => setNote(n)}>
              {n}
            </button>
          ))}
        </div>
        <input
          autoFocus
          placeholder="Escribe una nota"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button className="btn primary" onClick={() => onSave(note.trim())}>
          Guardar nota
        </button>
      </div>
    </div>
  );
}

/** Separador de la comanda: lo que se agregue después se imprime bajo este nombre. Puede quedar retenido hasta mandarlo. */
function SeparatorSheet({
  onPick,
  onClose,
}: {
  onPick: (label: string, hold: boolean) => void;
  onClose: () => void;
}) {
  const [custom, setCustom] = useState("");
  const [hold, setHold] = useState(false);
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet center" onClick={(e) => e.stopPropagation()}>
        <h3>Agregar separador</h3>
        <p className="small">
          Los productos que agregues después saldrán bajo este nombre en la comanda, para que la
          cocina sepa cuándo preparar cada parte.
        </p>
        <button
          className={`opt ${hold ? "on" : ""}`}
          style={{ textAlign: "left" }}
          onClick={() => setHold(!hold)}
        >
          {hold ? "✓ " : ""}Retener este tiempo: no sale a cocina hasta que lo mandes
        </button>
        <div className="row wrap">
          {COURSES.map((c) => (
            <button key={c} className="opt" onClick={() => onPick(c, hold)}>
              {c}
            </button>
          ))}
        </div>
        <div className="row">
          <input
            className="grow"
            placeholder="Otro nombre…"
            maxLength={40}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
          <button
            className="btn primary"
            style={{ minHeight: 48 }}
            disabled={!custom.trim()}
            onClick={() => onPick(custom.trim(), hold)}
          >
            Agregar
          </button>
        </div>
      </div>
    </div>
  );
}

/** Manda a cocina los tiempos retenidos (hold & fire). */
function FireSheet({
  accountId,
  courses,
  onClose,
}: {
  accountId: string;
  courses: string[];
  onClose: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const fire = (course?: string) =>
    api(`/api/accounts/${accountId}/fire`, { body: course ? { course } : {} }).then(onClose, (e) =>
      setErr((e as Error).message),
    );
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet center" onClick={(e) => e.stopPropagation()}>
        <h3>Mandar tiempo a cocina</h3>
        <p className="small">
          Estos tiempos esperan. Al mandarlos, cocina y barra reciben su comanda con el título
          "SALE".
        </p>
        {courses.map((c) => (
          <button
            key={c}
            className="btn primary"
            onClick={() => fire(c === "Tiempo" ? undefined : c)}
          >
            Mandar: {c}
          </button>
        ))}
        {courses.length > 1 && (
          <button className="btn" onClick={() => fire()}>
            Mandar todos
          </button>
        )}
        {err && <p className="err">{err}</p>}
      </div>
    </div>
  );
}

function GuestsSheet({
  accountId,
  current,
  onClose,
}: {
  accountId: string;
  current: number;
  onClose: () => void;
}) {
  const [n, setN] = useState(String(current));
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div
        className="sheet center"
        style={{ width: "min(360px, 100%)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Comensales</h3>
        <div
          className="num"
          style={{ fontSize: 44, fontWeight: 600, textAlign: "center", lineHeight: 1 }}
        >
          {n || "—"}
        </div>
        <NumPad value={n} onChange={setN} max={2} />
        {err && <p className="err">{err}</p>}
        <button
          className="btn primary"
          disabled={!n || Number(n) < 1}
          onClick={() =>
            api(`/api/accounts/${accountId}/guests`, { body: { guests: Number(n) } }).then(
              onClose,
              (e) => setErr((e as Error).message),
            )
          }
        >
          Guardar
        </button>
      </div>
    </div>
  );
}

function QtySheet({ onPick, onClose }: { onPick: (n: number) => void; onClose: () => void }) {
  const [n, setN] = useState("");
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div
        className="sheet center"
        style={{ width: "min(360px, 100%)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Cantidad del siguiente producto</h3>
        <div
          className="num"
          style={{ fontSize: 44, fontWeight: 600, textAlign: "center", lineHeight: 1 }}
        >
          ×{n || "—"}
        </div>
        <NumPad value={n} onChange={setN} max={2} />
        <button
          className="btn primary"
          disabled={!n || Number(n) < 1}
          onClick={() => onPick(Number(n))}
        >
          Usar ×{n || "…"}
        </button>
      </div>
    </div>
  );
}

export function ModifierSheet({
  product,
  groups,
  onDone,
  onCancel,
}: {
  product: { name: string };
  groups: Group[];
  onDone: (ids: string[], labels: string[], extra: number) => void;
  onCancel: () => void;
}) {
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const toggle = (g: Group, id: string) =>
    setSel((s) => {
      const cur = s[g.id] ?? [];
      if (cur.includes(id)) return { ...s, [g.id]: cur.filter((x) => x !== id) };
      if (!g.multiple) return { ...s, [g.id]: [id] };
      if (g.max_select && cur.length >= g.max_select) return s;
      return { ...s, [g.id]: [...cur, id] };
    });
  const ok = groups.every((g) => !g.required || (sel[g.id]?.length ?? 0) > 0);
  const chosen = groups.flatMap((g) => g.modifiers.filter((m) => sel[g.id]?.includes(m.id)));
  return (
    <div className="sheet-bg" onClick={onCancel}>
      <div className="sheet" style={{ overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
        <h3>{product.name}</h3>
        {groups.map((g) => (
          <div key={g.id} className="col">
            <div className="small">
              {g.name}
              {g.required ? " · obligatorio" : ""}
              {g.multiple ? " · varias" : ""}
            </div>
            <div className="row wrap">
              {g.modifiers.map((m) => (
                <button
                  key={m.id}
                  className={`opt ${sel[g.id]?.includes(m.id) ? "on" : ""}`}
                  onClick={() => toggle(g, m.id)}
                >
                  {m.name}
                  {m.price_cents ? ` +${money(m.price_cents)}` : ""}
                </button>
              ))}
            </div>
          </div>
        ))}
        <button
          className="btn primary"
          disabled={!ok}
          onClick={() =>
            onDone(
              chosen.map((m) => m.id),
              chosen.map((m) => m.name),
              chosen.reduce((s, m) => s + m.price_cents, 0),
            )
          }
        >
          Agregar
        </button>
      </div>
    </div>
  );
}

function CancelSheet({ item, onClose }: { item: Item; onClose: () => void }) {
  const [reason, setReason] = useState(REASONS[0]!);
  const [needAuth, setNeedAuth] = useState(false);
  const managers = useLive(
    () => api<{ id: string; name: string; role: string }[]>("/api/auth/users"),
    [],
  );
  const [authId, setAuthId] = useState("");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    try {
      await api(`/api/items/${item.id}/cancel`, {
        body: { reason, authorizerId: authId || undefined, authorizerPin: pin || undefined },
      });
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === "requiere_autorizacion") setNeedAuth(true);
      else
        setErr(
          e instanceof ApiError && e.code === "autorizacion_invalida"
            ? "Autorización inválida"
            : (e as Error).message,
        );
    }
  };
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet center" onClick={(e) => e.stopPropagation()}>
        <h3>
          Cancelar {item.quantity} × {item.name}
        </h3>
        <div className="row wrap">
          {REASONS.map((r) => (
            <button
              key={r}
              className={`opt ${reason === r ? "on" : ""}`}
              onClick={() => setReason(r)}
            >
              {r}
            </button>
          ))}
        </div>
        {needAuth && (
          <div className="col">
            <p className="small">Ya está en producción: requiere autorización de un gerente.</p>
            <select value={authId} onChange={(e) => setAuthId(e.target.value)}>
              <option value="">Gerente…</option>
              {managers.data
                ?.filter((u) => ["gerente", "admin"].includes(u.role))
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
            </select>
            <input
              type="password"
              inputMode="numeric"
              placeholder="PIN del gerente"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          </div>
        )}
        {err && <p className="err">{err}</p>}
        <div className="row">
          <button className="btn grow" onClick={onClose}>
            Volver
          </button>
          <button className="btn primary grow" onClick={submit}>
            Cancelar producto
          </button>
        </div>
      </div>
    </div>
  );
}

function MoveSheet({
  kind,
  accountId,
  onClose,
}: {
  kind: "transfer" | "move";
  accountId: string;
  onClose: () => void;
}) {
  const users = useLive(
    () => api<{ id: string; name: string; role: string }[]>("/api/auth/users"),
    [],
  );
  const tables = useLive(
    () => api<{ id: string; number: string; status: string }[]>("/api/tables"),
    [],
  );
  const [err, setErr] = useState<string | null>(null);
  const go = (path: string, body: unknown) =>
    api(`/api/accounts/${accountId}/${path}`, { body }).then(onClose, (e) =>
      setErr((e as Error).message),
    );
  const options =
    kind === "transfer"
      ? (users.data ?? [])
          .filter((u) => u.role === "mesero")
          .map((u) => ({ id: u.id, label: u.name, run: () => go("transfer", { waiterId: u.id }) }))
      : (tables.data ?? [])
          .filter((t) => t.status === "disponible")
          .map((t) => ({
            id: t.id,
            label: `Mesa ${t.number}`,
            run: () => go("move", { tableId: t.id }),
          }));
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div
        className="sheet center"
        style={{ height: "min(480px, 100%)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{kind === "transfer" ? "Transferir a otro mesero" : "Mover a otra mesa"}</h3>
        <PagedGrid
          items={options}
          minW={120}
          minH={56}
          empty={<p className="muted">No hay opciones disponibles</p>}
          render={(o) => (
            <button className="opt" style={{ height: "100%" }} onClick={o.run}>
              {o.label}
            </button>
          )}
        />
        {err && <p className="err">{err}</p>}
        <button className="btn" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </div>
  );
}

/** Dividir por producto o por asiento: lo elegido pasa a una cuenta nueva (para cobrarse aparte). */
function SplitSheet({ account, onClose }: { account: Account; onClose: () => void }) {
  const [sel, setSel] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const items = account.items.filter((i) => i.status === "activo");
  const toggle = (id: string) =>
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const total = items
    .filter((i) => sel.includes(i.id))
    .reduce((s, i) => s + i.quantity * i.unit_price_cents, 0);
  const seatIds = (n: number) => items.filter((i) => i.seat === n).map((i) => i.id);
  const seatsUsed = [
    ...new Set(items.map((i) => i.seat).filter((x): x is number => x !== null)),
  ].sort((a, b) => a - b);
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div
        className="sheet center"
        style={{ height: "min(560px, 100%)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Dividir cuenta: elige lo que pasa a la cuenta nueva</h3>
        {seatsUsed.length > 0 && (
          <div className="row wrap">
            <span className="small">Elegir por asiento:</span>
            {seatsUsed.map((n) => (
              <button
                key={n}
                className="opt"
                style={{ minHeight: 40 }}
                onClick={() => setSel(seatIds(n))}
              >
                Asiento {n}
              </button>
            ))}
          </div>
        )}
        <PagedRows
          items={items}
          rowH={52}
          row={(i) => (
            <td style={{ padding: 0 }}>
              <button
                className={`opt block ${sel.includes(i.id) ? "on" : ""}`}
                style={{ width: "100%", height: 48, textAlign: "left" }}
                onClick={() => toggle(i.id)}
              >
                {i.quantity} × {i.name}
                {i.seat ? ` · A${i.seat}` : ""} · {money(i.quantity * i.unit_price_cents)}
              </button>
            </td>
          )}
        />
        <p className="small">
          Para pagar en partes iguales o por asiento sin separar la cuenta, usa el cobro en Caja.
        </p>
        {err && <p className="err">{err}</p>}
        <button
          className="btn primary"
          disabled={sel.length === 0 || sel.length === items.length}
          onClick={() =>
            api(`/api/accounts/${account.id}/split`, { body: { itemIds: sel } }).then(
              onClose,
              (e) => setErr((e as Error).message),
            )
          }
        >
          Crear cuenta nueva {total ? "· " + money(total) : ""}
        </button>
      </div>
    </div>
  );
}

/** Juntar mesas: una mesa libre se une a la cuenta; una con cuenta se fusiona (y queda unida). */
export function MergeSheet({ account, onClose }: { account: { id: string }; onClose: () => void }) {
  const floor = useLive(
    () =>
      api<
        {
          id: string;
          number: string;
          status: string;
          capacity: number;
          linked_to: string | null;
          joined: string[];
          accounts: { id: string; total_cents: number; waiter: string }[];
        }[]
      >("/api/floor"),
    [],
  );
  const [err, setErr] = useState<string | null>(null);
  const mine = (floor.data ?? []).find((t) => t.accounts.some((x) => x.id === account.id));
  const options = (floor.data ?? []).filter(
    (t) =>
      t.id !== mine?.id &&
      !t.linked_to &&
      (t.status === "disponible" || t.status === "reservada" || t.accounts.length > 0) &&
      !t.accounts.some((x) => x.id === account.id),
  );
  const pick = (t: (typeof options)[number]) => {
    const req = t.accounts[0]
      ? api(`/api/accounts/${account.id}/merge`, { body: { sourceAccountId: t.accounts[0].id } })
      : api(`/api/accounts/${account.id}/join`, { body: { tableId: t.id } });
    req.then(onClose, (e) => setErr((e as Error).message));
  };
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div
        className="sheet center"
        style={{ height: "min(480px, 100%)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Juntar con otra mesa{mine ? ` (mesa ${mine.number})` : ""}</h3>
        <PagedGrid
          items={options}
          minW={150}
          minH={64}
          empty={<p className="muted">No hay mesas para juntar</p>}
          render={(t) => (
            <button className="opt" style={{ height: "100%" }} onClick={() => pick(t)}>
              Mesa {t.number}
              <br />
              <span className="small">
                {t.accounts[0]
                  ? `${t.accounts[0].waiter} · ${money(t.accounts[0].total_cents)}`
                  : `libre · ${t.capacity} pers.`}
              </span>
            </button>
          )}
        />
        {err && <p className="err">{err}</p>}
        <button className="btn" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </div>
  );
}
