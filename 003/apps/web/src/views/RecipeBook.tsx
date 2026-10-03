import { DeleteButton } from "../ui";
import { useState } from "react";
import { backdrop } from "../sheet";
import { api, can, money, photoSrc, serverUrl, useLive } from "../api";
import { Icon } from "../icons";
import { resizeImage } from "../image";
import { PagedColumns, PagedGrid, PagedRows, SubTabs } from "../fit";
import { fmt, toNum, UNITS, type Item } from "./InventoryAreas";

interface RCat {
  id: string;
  name: string;
  sort: number;
}
interface Summary {
  id: string;
  name: string;
  category_id: string | null;
  category: string | null;
  description: string | null;
  yield: number;
  yield_unit: string;
  prep_minutes: number | null;
  photo: string | null;
  product_id: string | null;
  product: string | null;
  ingredients: number;
  cost_per_portion_cents: number;
}
interface Ing {
  id: string;
  item_id: string | null;
  name: string;
  quantity: number;
  unit: string | null;
  note: string | null;
  stock: number | null;
  item_unit: string | null;
}
interface Full extends Omit<Summary, "ingredients"> {
  instructions: string | null;
  ingredients: Ing[];
  batch_cost_cents: number;
}
interface Product {
  id: string;
  name: string;
}

const HUES = [18, 28, 160, 205, 285, 340, 45, 120];
const hue = (s: string) => HUES[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length]!;
/** Los pasos se escriben uno por línea; si ya traen «1.» se quita para numerarlos al mostrarlos. */
const stepsOf = (t: string | null) =>
  (t ?? "")
    .split("\n")
    .map((s) => s.trim().replace(/^\d+\s*[.)-]\s*/, ""))
    .filter(Boolean);

/** Recetario: recetas de comida, tragos, salsas… con categorías que elige el usuario. */
export function RecipeBook() {
  const cats = useLive(() => api<RCat[]>("/api/recipe-categories"), [], [], "rb-cats");
  const list = useLive(() => api<Summary[]>("/api/recipe-book"), ["recipe.updated"], [], "rb-list");
  const [cat, setCat] = useState<string>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | "new" | null>(null);
  const [manage, setManage] = useState(false);
  const edit = can("recipe.manage");
  const shown = (list.data ?? []).filter(
    (r) =>
      (cat === "all" || (cat === "none" ? !r.category_id : r.category_id === cat)) &&
      (!q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase())),
  );
  const count = (id: string) =>
    (list.data ?? []).filter((r) => (id === "none" ? !r.category_id : r.category_id === id)).length;
  const reload = () => {
    list.reload();
    cats.reload();
  };
  return (
    <div className="view">
      <div className="row wrap" style={{ flex: "none" }}>
        <button
          type="button"
          className={`chip ${cat === "all" ? "on" : ""}`}
          onClick={() => setCat("all")}
        >
          Todas
        </button>
        {cats.data?.map((c) => (
          <button
            type="button"
            key={c.id}
            className={`chip ${cat === c.id ? "on" : ""}`}
            onClick={() => setCat(c.id)}
          >
            {c.name} <span style={{ opacity: 0.6 }}>{count(c.id)}</span>
          </button>
        ))}
        {count("none") > 0 && (
          <button
            type="button"
            className={`chip ${cat === "none" ? "on" : ""}`}
            onClick={() => setCat("none")}
          >
            Sin categoría
          </button>
        )}
        <span className="grow" />
        <input
          placeholder="Buscar receta…"
          aria-label="Buscar receta"
          style={{ width: 200, minHeight: 40 }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {edit && (
          <button type="button" className="btn sm" onClick={() => setManage(true)}>
            Categorías
          </button>
        )}
        {edit && (
          <button
            type="button"
            className="btn primary sm"
            style={{ minHeight: 40 }}
            onClick={() => setOpen("new")}
          >
            + Nueva receta
          </button>
        )}
      </div>
      <PagedGrid
        items={shown}
        minW={210}
        minH={170}
        empty={
          <p className="muted">
            {(list.data ?? []).length === 0
              ? "Aún no hay recetas. Crea la primera con «+ Nueva receta»."
              : "Ninguna receta coincide"}
          </p>
        }
        render={(r) => (
          <button type="button" className="recipe-card" onClick={() => setOpen(r.id)}>
            <div
              className="ph"
              style={
                r.photo
                  ? { backgroundImage: `url(${photoSrc(r.photo)})` }
                  : {
                      background: `linear-gradient(135deg, hsl(${hue(r.name)} 70% 62%), hsl(${(hue(r.name) + 30) % 360} 70% 38%))`,
                    }
              }
            >
              {!r.photo && <span>{r.name.slice(0, 1).toUpperCase()}</span>}
            </div>
            <div className="rt">
              <strong className="ellipsis">{r.name}</strong>
              <span className="small ellipsis">
                {r.category ?? "Sin categoría"} · {fmt(r.yield)} {r.yield_unit}
                {r.prep_minutes ? ` · ${r.prep_minutes} min` : ""}
              </span>
              {r.cost_per_portion_cents > 0 && (
                <span className="small">Costo por porción {money(r.cost_per_portion_cents)}</span>
              )}
            </div>
          </button>
        )}
      />
      {open && open !== "new" && (
        <RecipeView
          id={open}
          onClose={() => setOpen(null)}
          onEdit={() => setOpen("edit:" + open)}
          onChanged={reload}
        />
      )}
      {open === "new" && (
        <RecipeEditor
          id={null}
          cats={cats.data ?? []}
          onClose={(saved) => {
            setOpen(null);
            if (saved) reload();
          }}
        />
      )}
      {open?.startsWith("edit:") && (
        <RecipeEditor
          id={open.slice(5)}
          cats={cats.data ?? []}
          onClose={(saved) => {
            setOpen(null);
            if (saved) reload();
          }}
        />
      )}
      {manage && (
        <CategoriesSheet
          cats={cats.data ?? []}
          onClose={() => {
            setManage(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function RecipeView({
  id,
  onClose,
  onEdit,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const rec = useLive(() => api<Full>(`/api/recipe-book/${id}`), ["recipe.updated"], [id]);
  const r = rec.data;
  const [portions, setPortions] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  const manage = can("recipe.manage");
  const n = portions ?? r?.yield ?? 1;
  const factor = r ? n / r.yield : 1;
  const steps = stepsOf(r?.instructions ?? null);
  const step = (v: number) => setPortions(Math.max(1, Math.round((n + v) * 100) / 100));
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        await fetch(serverUrl(`/api/recipe-book/${id}/text?portions=${n}`), {
          headers: {
            Authorization: `Bearer ${JSON.parse(localStorage.getItem("003.session") ?? "{}").token}`,
          },
        }).then((x) => x.text()),
      );
      setMsg("Receta copiada");
    } catch {
      setMsg("No se pudo copiar");
    }
  };
  return (
    <div className="sheet-bg" {...backdrop(onClose)}>
      <div className="sheet center" style={{ width: "min(980px, 100%)", height: "100%" }}>
        <div className="row spread" style={{ flex: "none" }}>
          <div style={{ minWidth: 0 }}>
            <h2 className="ellipsis">{r?.name}</h2>
            <div className="row wrap" style={{ gap: 6 }}>
              <span className="tag">{r?.category ?? "Sin categoría"}</span>
              {r?.prep_minutes ? <span className="tag">{r.prep_minutes} min</span> : null}
              {r && r.cost_per_portion_cents > 0 ? (
                <span className="tag">Costo por porción {money(r.cost_per_portion_cents)}</span>
              ) : null}
              {r?.product ? <span className="tag ember">Platillo: {r.product}</span> : null}
            </div>
          </div>
          <div className="row">
            <div className="stepper" role="group" aria-label="Porciones">
              <button
                type="button"
                className="btn"
                aria-label="Menos porciones"
                onClick={() => step(-1)}
              >
                −
              </button>
              <span className="num" style={{ minWidth: 70, textAlign: "center", fontWeight: 700 }}>
                {fmt(n)} <span className="small">{r?.yield_unit}</span>
              </span>
              <button
                type="button"
                className="btn"
                aria-label="Más porciones"
                onClick={() => step(1)}
              >
                +
              </button>
            </div>
            <button type="button" className="btn sm" onClick={onClose}>
              Cerrar
            </button>
          </div>
        </div>
        {r?.description && (
          <p className="small" style={{ flex: "none" }}>
            {r.description}
          </p>
        )}
        {err && <p className="err">{err}</p>}
        <div className="split" style={{ gap: 16 }}>
          <section className="col" style={{ width: "40%", flex: "none", minHeight: 0 }}>
            <strong>Ingredientes</strong>
            <PagedRows
              fixed
              items={r?.ingredients ?? []}
              rowH={46}
              empty={<p className="muted small">Sin ingredientes</p>}
              row={(i) => (
                <>
                  <td className="r num" style={{ width: 96, fontWeight: 700 }}>
                    {fmt(i.quantity * factor)} {i.unit ?? i.item_unit ?? ""}
                  </td>
                  <td className="ellipsis">
                    {i.name}
                    {i.note ? <span className="small"> · {i.note}</span> : null}
                  </td>
                </>
              )}
            />
          </section>
          <section className="col" style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
            <strong>Preparación</strong>
            <PagedColumns
              items={steps.map((t, i) => ({ t, i }))}
              colMinW={280}
              est={(s) => 30 + Math.ceil(s.t.length / 36) * 24}
              empty={<p className="muted small">Sin pasos escritos</p>}
              render={(s) => (
                <div className="step">
                  <b>{s.i + 1}</b>
                  <p>{s.t}</p>
                </div>
              )}
            />
          </section>
        </div>
        {msg && <p className="small">{msg}</p>}
        <div className="row wrap" style={{ flex: "none", justifyContent: "space-between" }}>
          <div className="row wrap">
            <button type="button" className="btn" onClick={copy}>
              Copiar
            </button>
            <button type="button" className="btn" onClick={() => window.print()}>
              Imprimir
            </button>
            {manage && r?.product_id && (
              <button
                type="button"
                className="btn"
                onClick={() =>
                  api<{ items: number }>(`/api/recipe-book/${id}/apply-to-product`, {
                    body: {},
                  }).then(
                    (x) =>
                      setMsg(
                        `Cada venta de «${r.product}» descontará ${x.items} insumo(s) del inventario`,
                      ),
                    (e) => setErr((e as Error).message),
                  )
                }
              >
                Usar para descontar inventario
              </button>
            )}
          </div>
          {manage && (
            <div className="row wrap">
              {sure ? (
                <button
                  type="button"
                  className="btn"
                  style={{ color: "var(--bad)" }}
                  onClick={() =>
                    api(`/api/recipe-book/${id}`, { method: "DELETE" }).then(
                      () => {
                        onChanged();
                        onClose();
                      },
                      (e) => setErr((e as Error).message),
                    )
                  }
                >
                  ¿Seguro? Sí, eliminar
                </button>
              ) : (
                <button type="button" className="btn ghost" onClick={() => setSure(true)}>
                  Eliminar
                </button>
              )}
              <button type="button" className="btn primary" onClick={onEdit}>
                Editar
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface Line {
  itemId: string;
  name: string;
  qty: string;
  unit: string;
  note: string;
}

function RecipeEditor({
  id,
  cats,
  onClose,
}: {
  id: string | null;
  cats: RCat[];
  onClose: (saved: boolean) => void;
}) {
  const cur = useLive(
    () => (id ? api<Full>(`/api/recipe-book/${id}`) : Promise.resolve(null)),
    [],
    [id ?? ""],
  );
  const items = useLive(() => api<Item[]>("/api/inventory/items").catch(() => [] as Item[]), []);
  const products = useLive(() => api<Product[]>("/api/products"), []);
  const [tab, setTab] = useState<"datos" | "ingredientes" | "preparacion">("datos");
  const [f, setF] = useState<{
    name: string;
    cat: string;
    desc: string;
    yield: string;
    unit: string;
    mins: string;
    product: string;
    steps: string;
  } | null>(null);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [photo, setPhoto] = useState<{ pending: string | null; remove: boolean }>({
    pending: null,
    remove: false,
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const c = cur.data;
  if (id && !c)
    return (
      <div className="sheet-bg" {...backdrop(() => onClose(false))}>
        <div className="sheet center" role="dialog" aria-modal="true">
          <p className="muted">Cargando…</p>
        </div>
      </div>
    );
  const form = f ?? {
    name: c?.name ?? "",
    cat: c?.category_id ?? "",
    desc: c?.description ?? "",
    yield: c ? String(c.yield) : "1",
    unit: c?.yield_unit ?? "porciones",
    mins: c?.prep_minutes ? String(c.prep_minutes) : "",
    product: c?.product_id ?? "",
    steps: c?.instructions ?? "",
  };
  const rows: Line[] =
    lines ??
    (c?.ingredients ?? []).map((i) => ({
      itemId: i.item_id ?? "",
      name: i.name,
      qty: String(i.quantity),
      unit: i.unit ?? "",
      note: i.note ?? "",
    }));
  const set = (patch: Partial<typeof form>) => setF({ ...form, ...patch });
  const setRows = (r: Line[]) => setLines(r);
  const photoNow = photo.pending ?? (photo.remove ? null : photoSrc(c?.photo));
  const pick = (file?: File) => {
    if (file)
      resizeImage(file, 720, 0.82).then(
        (d) => setPhoto({ pending: d, remove: false }),
        (e) => setErr((e as Error).message),
      );
  };
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body = {
        name: form.name.trim(),
        category_id: form.cat || null,
        description: form.desc.trim() || null,
        instructions: form.steps.trim() || null,
        yield: toNum(form.yield) || 1,
        yield_unit: form.unit.trim() || "porciones",
        prep_minutes: form.mins ? Math.round(toNum(form.mins)) : null,
        product_id: form.product || null,
        ingredients: rows
          .filter((r) => toNum(r.qty) > 0 && (r.itemId || r.name.trim()))
          .map((r) => ({
            itemId: r.itemId || null,
            name: r.itemId ? undefined : r.name.trim(),
            quantity: toNum(r.qty),
            unit: r.unit || null,
            note: r.note.trim() || null,
          })),
      };
      const rid = id ?? (await api<{ id: string }>("/api/recipe-book", { body })).id;
      if (id) await api(`/api/recipe-book/${id}`, { method: "PATCH", body });
      if (photo.pending)
        await api(`/api/recipe-book/${rid}/photo`, { body: { data: photo.pending } });
      else if (photo.remove && c?.photo)
        await api(`/api/recipe-book/${rid}/photo`, { method: "DELETE" });
      onClose(true);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="sheet-bg" {...backdrop(() => !busy && onClose(false))}>
      <div
        className="sheet center"
        style={{ width: "min(860px, 100%)", height: "min(620px, 100%)" }}
      >
        <div className="row spread" style={{ flex: "none" }}>
          <h3>{id ? "Editar receta" : "Nueva receta"}</h3>
          <SubTabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "datos", label: "Datos" },
              { id: "ingredientes", label: `Ingredientes (${rows.length})` },
              { id: "preparacion", label: "Preparación" },
            ]}
          />
        </div>
        {tab === "datos" && (
          <div className="grid2" style={{ flex: 1, minHeight: 0, alignContent: "start" }}>
            <input
              autoFocus
              placeholder="Nombre de la receta"
              aria-label="Nombre de la receta"
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
            />
            <select
              aria-label="Categoría"
              value={form.cat}
              onChange={(e) => set({ cat: e.target.value })}
            >
              <option value="">Sin categoría</option>
              {cats.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
            <div className="row">
              <input
                className="grow"
                placeholder="Rinde"
                aria-label="Rendimiento"
                inputMode="decimal"
                value={form.yield}
                onChange={(e) => set({ yield: e.target.value })}
              />
              <input
                className="grow"
                placeholder="porciones, copas, litros…"
                aria-label="Unidad del rendimiento"
                value={form.unit}
                onChange={(e) => set({ unit: e.target.value })}
              />
            </div>
            <input
              placeholder="Minutos de preparación"
              aria-label="Minutos"
              inputMode="numeric"
              value={form.mins}
              onChange={(e) => set({ mins: e.target.value })}
            />
            <select
              aria-label="Platillo del menú"
              value={form.product}
              onChange={(e) => set({ product: e.target.value })}
            >
              <option value="">Sin ligar a un platillo del menú</option>
              {products.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  Platillo: {p.name}
                </option>
              ))}
            </select>
            <input
              placeholder="Descripción corta (opcional)"
              aria-label="Descripción"
              value={form.desc}
              onChange={(e) => set({ desc: e.target.value })}
            />
            <div className="row" style={{ gridColumn: "1 / -1", gap: 12 }}>
              <div className="portrait" style={{ width: 84, height: 84 }}>
                {photoNow ? (
                  <img src={photoNow} alt="Foto de la receta" />
                ) : (
                  <Icon name="camara" size={28} />
                )}
              </div>
              <div className="col" style={{ gap: 6 }}>
                <label
                  className="btn sm"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                  }}
                >
                  Elegir foto
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => {
                      pick(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
                {photoNow && (
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => setPhoto({ pending: null, remove: true })}
                  >
                    Quitar foto
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        {tab === "ingredientes" && (
          <div className="col" style={{ flex: 1, minHeight: 0 }}>
            <PagedRows
              fixed
              items={rows.map((r, i) => ({ r, i }))}
              rowH={56}
              empty={
                <p className="muted small">Agrega los ingredientes con los botones de abajo</p>
              }
              row={({ r, i }) => (
                <td style={{ padding: 0 }}>
                  <div className="row" style={{ height: 56, gap: 6 }}>
                    <input
                      style={{ width: 82, minHeight: 40 }}
                      aria-label={`Cantidad de ${r.name || "ingrediente"}`}
                      inputMode="decimal"
                      placeholder="Cant."
                      value={r.qty}
                      onChange={(e) =>
                        setRows(rows.map((x, k) => (k === i ? { ...x, qty: e.target.value } : x)))
                      }
                    />
                    <select
                      style={{ width: 84, minHeight: 40 }}
                      aria-label="Unidad"
                      value={r.unit}
                      onChange={(e) =>
                        setRows(rows.map((x, k) => (k === i ? { ...x, unit: e.target.value } : x)))
                      }
                    >
                      <option value="">u.</option>
                      {UNITS.map((u) => (
                        <option key={u}>{u}</option>
                      ))}
                    </select>
                    {r.itemId ? (
                      <span className="grow ellipsis">
                        <strong>{r.name}</strong> <span className="tag">inventario</span>
                      </span>
                    ) : (
                      <input
                        className="grow"
                        style={{ minHeight: 40 }}
                        aria-label="Nombre del ingrediente"
                        placeholder="Ingrediente"
                        value={r.name}
                        onChange={(e) =>
                          setRows(
                            rows.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)),
                          )
                        }
                      />
                    )}
                    <input
                      style={{ width: 130, minHeight: 40 }}
                      aria-label="Nota"
                      placeholder="nota"
                      value={r.note}
                      onChange={(e) =>
                        setRows(rows.map((x, k) => (k === i ? { ...x, note: e.target.value } : x)))
                      }
                    />
                    <button
                      type="button"
                      className="btn ghost sm"
                      aria-label="Quitar ingrediente"
                      onClick={() => setRows(rows.filter((_, k) => k !== i))}
                    >
                      <Icon name="cerrar" size={18} />
                    </button>
                  </div>
                </td>
              )}
            />
            <div className="row wrap" style={{ flex: "none" }}>
              <select
                aria-label="Agregar insumo del inventario"
                value=""
                style={{ width: 240 }}
                onChange={(e) => {
                  const it = items.data?.find((x) => x.id === e.target.value);
                  if (it)
                    setRows([
                      ...rows,
                      { itemId: it.id, name: it.name, qty: "", unit: it.unit, note: "" },
                    ]);
                }}
              >
                <option value="">+ Insumo del inventario…</option>
                {items.data?.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  setRows([...rows, { itemId: "", name: "", qty: "", unit: "", note: "" }])
                }
              >
                + Ingrediente libre
              </button>
              <span className="small">
                Los del inventario dan el costo y pueden descontar existencias.
              </span>
            </div>
          </div>
        )}
        {tab === "preparacion" && (
          <div className="col" style={{ flex: 1, minHeight: 0 }}>
            <p className="small">Escribe un paso por renglón; al verla se numeran solos.</p>
            <textarea
              aria-label="Preparación"
              style={{ flex: 1, resize: "none", overflow: "hidden", padding: 12, lineHeight: 1.5 }}
              value={form.steps}
              onChange={(e) => set({ steps: e.target.value })}
              placeholder={
                "Limpiar el camarón\nLicuar el chile con el limón\nBañar y servir de inmediato"
              }
            />
          </div>
        )}
        {err && <p className="err">{err}</p>}
        <div className="row" style={{ justifyContent: "flex-end", flex: "none" }}>
          <button type="button" className="btn" disabled={busy} onClick={() => onClose(false)}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || !form.name.trim()}
            onClick={save}
          >
            Guardar
          </button>
        </div>
      </div>
    </div>
  );
}

function CategoriesSheet({ cats, onClose }: { cats: RCat[]; onClose: () => void }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const data = useLive(() => api<RCat[]>("/api/recipe-categories"), [], [cats.length]);
  const run = (p: Promise<unknown>, after?: () => void) =>
    p.then(
      () => {
        setErr(null);
        data.reload();
        after?.();
      },
      (e) => setErr((e as Error).message),
    );
  return (
    <div className="sheet-bg" {...backdrop(onClose)}>
      <div
        className="sheet center"
        style={{ width: "min(560px, 100%)", height: "min(520px, 100%)" }}
      >
        <div className="row spread">
          <h3>Categorías de recetas</h3>
          <button type="button" className="btn sm" onClick={onClose}>
            Cerrar
          </button>
        </div>
        <p className="small">
          Crea las que necesites: Comida, Tragos, Salsas, Postres, Desayunos, Brunch… Si borras una,
          sus recetas quedan «sin categoría».
        </p>
        {err && <p className="err">{err}</p>}
        <PagedRows
          fixed
          items={data.data ?? []}
          rowH={52}
          row={(k) => (
            <td style={{ padding: 0 }}>
              <div className="row" style={{ height: 52, gap: 6 }}>
                <input
                  className="grow"
                  defaultValue={k.name}
                  aria-label={`Nombre de la categoría ${k.name}`}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== k.name)
                      run(
                        api(`/api/recipe-categories/${k.id}`, {
                          method: "PATCH",
                          body: { name: v },
                        }),
                      );
                  }}
                />
                <DeleteButton
                  what={`la categoría «${k.name}»`}
                  onConfirm={() => run(api(`/api/recipe-categories/${k.id}`, { method: "DELETE" }))}
                />
              </div>
            </td>
          )}
        />
        <div className="row">
          <input
            className="grow"
            placeholder="Nueva categoría"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            type="button"
            className="btn primary"
            disabled={!name.trim()}
            onClick={() =>
              run(api("/api/recipe-categories", { body: { name: name.trim() } }), () => setName(""))
            }
          >
            Agregar
          </button>
        </div>
      </div>
    </div>
  );
}
