import { useState } from "react";
import { backdrop } from "../sheet";
import { api, money, photoSrc, useLive } from "../api";
import { resizeImage } from "../image";
import { Icon } from "../icons";
import { flattenCategories, type Category } from "../categories";
import { PagedGrid, PagedRows } from "../fit";

interface Area {
  id: string;
  name: string;
  kind: string;
}
interface Subarea {
  id: string;
  area_id: string;
  name: string;
}
interface Station {
  id: string;
  subarea_id: string;
  name: string;
}
interface Product {
  id: string;
  name: string;
  price_cents: number;
  category_id: string | null;
  station_ids: string[];
  availability?: string;
  photo?: string | null;
}
interface CategoryRoute {
  category_id: string;
  station_id: string;
}

/** Estaciones con el nombre de su área: "Cocina › Plancha". */
export function useStations() {
  const areas = useLive(() => api<Area[]>("/api/areas"), []);
  const subareas = useLive(() => api<Subarea[]>("/api/subareas"), []);
  const stations = useLive(() => api<Station[]>("/api/stations"), []);
  const list = (stations.data ?? []).map((s) => {
    const sub = subareas.data?.find((x) => x.id === s.subarea_id);
    const area = areas.data?.find((a) => a.id === sub?.area_id);
    return {
      ...s,
      areaId: area?.id ?? "",
      areaName: area?.name ?? "",
      label: `${area?.name ?? "?"} › ${s.name}`,
    };
  });
  const reload = () => {
    areas.reload();
    subareas.reload();
    stations.reload();
  };
  return { areas: areas.data ?? [], stations: list, reload };
}

/** Elige estaciones agrupadas por área. */
export function StationPicker({
  value,
  onChange,
  areas,
  stations,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  areas: Area[];
  stations: { id: string; name: string; areaId: string }[];
}) {
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="col" style={{ gap: 6 }}>
      {areas
        .filter((a) => stations.some((s) => s.areaId === a.id))
        .map((a) => (
          <div key={a.id} className="row wrap" style={{ gap: 6 }}>
            <span className="small" style={{ width: 70 }}>
              {a.name}
            </span>
            {stations
              .filter((s) => s.areaId === a.id)
              .map((s) => (
                <button
                  type="button"
                  key={s.id}
                  className={`opt ${value.includes(s.id) ? "on" : ""}`}
                  style={{ minHeight: 40, padding: "0 12px" }}
                  onClick={() => toggle(s.id)}
                >
                  {s.name}
                </button>
              ))}
          </div>
        ))}
    </div>
  );
}

/**
 * Áreas de producción (Cocina, Barra, Terraza…): el usuario crea áreas y estaciones y decide qué productos
 * se preparan en cada una. Una comanda con refresco, taco y mojito se divide sola entre barra y cocina.
 */
export function Areas() {
  const venue = useStations();
  const products = useLive(() => api<Product[]>("/api/products"), ["product.updated"]);
  const [areaId, setAreaId] = useState<string | null>(null);
  const [stationId, setStationId] = useState<string | null>(null);
  const [newArea, setNewArea] = useState("");
  const [newStation, setNewStation] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const fail = (e: unknown) => setErr((e as Error).message);

  const production = venue.areas.filter((a) => a.kind === "produccion");
  const area = production.find((a) => a.id === areaId) ?? production[0];
  const stations = venue.stations.filter((s) => s.areaId === area?.id);
  const station = stations.find((s) => s.id === stationId) ?? stations[0];
  const countFor = (sid: string) =>
    (products.data ?? []).filter((p) => p.station_ids.includes(sid)).length;

  const toggleProduct = (p: Product) => {
    if (!station) return;
    const has = p.station_ids.includes(station.id);
    const next = has
      ? p.station_ids.filter((x) => x !== station.id)
      : [...p.station_ids, station.id];
    api(`/api/products/${p.id}`, { method: "PATCH", body: { station_ids: next } }).then(
      () => {
        setErr(null);
        products.reload();
      },
      () =>
        setErr(
          `"${p.name}" debe enviarse al menos a una estación: elígele otra antes de quitarla de ${station.name}.`,
        ),
    );
  };

  return (
    <div className="split">
      <section className="card fillcard" style={{ maxWidth: 270, flex: "none", width: 270 }}>
        <h3>Áreas</h3>
        <PagedRows
          items={production}
          rowH={52}
          empty={<p className="muted">Crea tu primera área</p>}
          row={(a) => (
            <td style={{ padding: 0 }}>
              <button
                type="button"
                className={`opt ${a.id === area?.id ? "on" : ""}`}
                style={{ width: "100%", height: 46, textAlign: "left" }}
                onClick={() => {
                  setAreaId(a.id);
                  setStationId(null);
                }}
              >
                {a.name}
              </button>
            </td>
          )}
        />
        <div className="row" style={{ flex: "none" }}>
          <input
            className="grow"
            placeholder="Nueva área (Barra, Terraza…)"
            value={newArea}
            onChange={(e) => setNewArea(e.target.value)}
          />
          <button
            type="button"
            className="btn"
            disabled={!newArea.trim()}
            onClick={() =>
              api<{ id: string }>("/api/areas", {
                body: { name: newArea.trim(), kind: "produccion" },
              }).then((r) => {
                setNewArea("");
                setAreaId(r.id);
                venue.reload();
                setErr(null);
              }, fail)
            }
          >
            +
          </button>
        </div>
      </section>

      <section className="card fillcard" style={{ maxWidth: 290, flex: "none", width: 290 }}>
        <div className="row spread">
          <div style={{ minWidth: 0 }}>
            <h3>Estaciones</h3>
            {area && <div className="small ellipsis">de {area.name}</div>}
          </div>
          {area && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() =>
                api(`/api/areas/${area.id}`, { method: "DELETE" }).then(() => {
                  setAreaId(null);
                  venue.reload();
                  setErr(null);
                }, fail)
              }
            >
              Eliminar área
            </button>
          )}
        </div>
        <PagedRows
          items={stations}
          rowH={56}
          empty={
            <p className="muted small">
              Un área necesita al menos una estación: el punto donde se prepara (plancha, barra,
              freidora…)
            </p>
          }
          row={(s) => (
            <td style={{ padding: 0 }}>
              <div className="row" style={{ height: 56 }}>
                <button
                  type="button"
                  className={`opt grow ${s.id === station?.id ? "on" : ""}`}
                  style={{ height: 48, textAlign: "left" }}
                  onClick={() => setStationId(s.id)}
                >
                  {s.name}{" "}
                  <span className="small" style={{ color: "inherit", opacity: 0.7 }}>
                    · {countFor(s.id)}
                  </span>
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  aria-label="Eliminar estación"
                  onClick={() =>
                    api(`/api/stations/${s.id}`, { method: "DELETE" }).then(() => {
                      setStationId(null);
                      venue.reload();
                      setErr(null);
                    }, fail)
                  }
                >
                  ✕
                </button>
              </div>
            </td>
          )}
        />
        {area && (
          <div className="row" style={{ flex: "none" }}>
            <input
              className="grow"
              placeholder="Nueva estación"
              value={newStation}
              onChange={(e) => setNewStation(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              disabled={!newStation.trim()}
              onClick={() =>
                api<{ id: string }>(`/api/areas/${area.id}/stations`, {
                  body: { name: newStation.trim() },
                }).then((r) => {
                  setNewStation("");
                  setStationId(r.id);
                  venue.reload();
                  setErr(null);
                }, fail)
              }
            >
              +
            </button>
          </div>
        )}
      </section>

      <section className="card fillcard">
        <h3 className="ellipsis">
          {station
            ? `Productos que se preparan en ${station.areaName} › ${station.name}`
            : "Productos"}
        </h3>
        <p className="small">
          Toca un producto para enviarlo (o dejar de enviarlo) a esta estación. Un producto puede ir
          a varias.
        </p>
        {err && <p className="err">{err}</p>}
        <PagedGrid
          items={products.data ?? []}
          minW={150}
          minH={56}
          gap={8}
          empty={<p className="muted">Aún no hay productos</p>}
          render={(p) => {
            const on = !!station && p.station_ids.includes(station.id);
            const elsewhere = venue.stations
              .filter((s) => p.station_ids.includes(s.id) && s.id !== station?.id)
              .map((s) => s.name);
            return (
              <button
                type="button"
                className={`opt ${on ? "on" : ""}`}
                style={{
                  height: "100%",
                  textAlign: "left",
                  padding: "4px 12px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                }}
                disabled={!station}
                onClick={() => toggleProduct(p)}
              >
                <span className="ellipsis" style={{ fontWeight: 600 }}>
                  {p.name}
                </span>
                <span className="ellipsis" style={{ fontSize: 12, opacity: 0.75 }}>
                  {on
                    ? "✓ aquí"
                    : elsewhere.length
                      ? `va a ${elsewhere.join(", ")}`
                      : "sin destino"}
                </span>
              </button>
            );
          }}
        />
      </section>
    </div>
  );
}

type Node = ReturnType<typeof flattenCategories>[number];

/** Categorías propias con subcategorías (Tacos › Tacos de calamar…) y su destino por defecto. */
export function Categories() {
  const cats = useLive(() => api<Category[]>("/api/categories"), []);
  const products = useLive(() => api<Product[]>("/api/products"), ["product.updated"]);
  const routes = useLive(() => api<CategoryRoute[]>("/api/category-routes"), []);
  const venue = useStations();
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [editing, setEditing] = useState<Node | null>(null);
  const [routing, setRouting] = useState<Node | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fail = (e: unknown) => setErr((e as Error).message);
  const tree = flattenCategories(cats.data ?? []);
  const reload = () => {
    cats.reload();
    routes.reload();
    products.reload();
  };
  const count = (id: string) => (products.data ?? []).filter((p) => p.category_id === id).length;
  // Destino propio de la categoría o, si no tiene, el de su categoría principal ("hereda")
  const destination = (id: string) => {
    let cur: string | null = id;
    for (let depth = 0; cur && depth < 5; depth++) {
      const own: string = cur;
      const names = venue.stations
        .filter((s) => routes.data?.some((r) => r.category_id === own && r.station_id === s.id))
        .map((s) => s.name);
      if (names.length) return depth === 0 ? names.join(", ") : `${names.join(", ")} (hereda)`;
      const parent: string | null = (cats.data ?? []).find((c) => c.id === own)?.parent_id ?? null;
      cur = parent;
    }
    return "—";
  };

  return (
    <div className="split">
      <section className="card fillcard">
        {err && <p className="err">{err}</p>}
        <PagedRows
          items={tree}
          rowH={52}
          empty={<p className="muted">Crea tus categorías: Tacos, Platos fuertes, Refrescos…</p>}
          head={
            <tr>
              <th>Categoría</th>
              <th className="r">Productos</th>
              <th>Se envía a</th>
              <th />
            </tr>
          }
          row={(c) => (
            <>
              <td className="ellipsis" style={{ maxWidth: 200 }}>
                <span style={{ paddingLeft: c.depth * 20 }}>
                  {c.depth > 0 ? "↳ " : ""}
                  <strong style={{ fontWeight: c.depth ? 500 : 600 }}>{c.name}</strong>
                </span>
              </td>
              <td className="r num">{count(c.id)}</td>
              <td className="small ellipsis" style={{ maxWidth: 160 }}>
                {destination(c.id)}
              </td>
              <td className="r">
                <div className="row" style={{ justifyContent: "flex-end", gap: 4 }}>
                  <button type="button" className="btn sm" onClick={() => setRouting(c)}>
                    Destino
                  </button>
                  <button type="button" className="btn ghost sm" onClick={() => setEditing(c)}>
                    Editar
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() =>
                      api(`/api/categories/${c.id}`, { method: "DELETE" }).then(() => {
                        setErr(null);
                        reload();
                      }, fail)
                    }
                  >
                    ✕
                  </button>
                </div>
              </td>
            </>
          )}
        />
      </section>
      <section className="card col" style={{ width: 330, flex: "none", alignSelf: "flex-start" }}>
        <h3>Nueva categoría</h3>
        <input
          placeholder="Nombre (Tacos, Refrescos…)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select value={parent} onChange={(e) => setParent(e.target.value)}>
          <option value="">Categoría principal</option>
          {tree
            .filter((c) => c.depth < 2)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {"— ".repeat(c.depth)}Dentro de: {c.name}
              </option>
            ))}
        </select>
        <p className="small">
          Una subcategoría (Tacos de calamar dentro de Tacos) hereda el destino de su categoría
          principal.
        </p>
        <button
          type="button"
          className="btn primary"
          disabled={!name.trim()}
          onClick={() =>
            api("/api/categories", { body: { name: name.trim(), parent_id: parent || null } }).then(
              () => {
                setName("");
                setErr(null);
                reload();
              },
              fail,
            )
          }
        >
          Crear categoría
        </button>
      </section>
      {editing && (
        <EditCategory
          node={editing}
          tree={tree}
          onClose={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {routing && (
        <RouteCategory
          node={routing}
          venue={venue}
          current={(routes.data ?? [])
            .filter((r) => r.category_id === routing.id)
            .map((r) => r.station_id)}
          productCount={count(routing.id)}
          onClose={() => {
            setRouting(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function EditCategory({ node, tree, onClose }: { node: Node; tree: Node[]; onClose: () => void }) {
  const [name, setName] = useState(node.name);
  const [parent, setParent] = useState(node.parent_id ?? "");
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="sheet-bg" {...backdrop(onClose)}>
      <div className="sheet center" role="dialog" aria-modal="true">
        <h3>Editar categoría</h3>
        <input value={name} onChange={(e) => setName(e.target.value)} />
        <select value={parent} onChange={(e) => setParent(e.target.value)}>
          <option value="">Categoría principal</option>
          {tree
            .filter((c) => c.id !== node.id && c.depth < 2)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {"— ".repeat(c.depth)}Dentro de: {c.name}
              </option>
            ))}
        </select>
        {err && <p className="err">{err}</p>}
        <button
          type="button"
          className="btn primary"
          disabled={!name.trim()}
          onClick={() =>
            api(`/api/categories/${node.id}`, {
              method: "PATCH",
              body: { name: name.trim(), parent_id: parent || null },
            }).then(onClose, (e) => setErr((e as Error).message))
          }
        >
          Guardar
        </button>
      </div>
    </div>
  );
}

function RouteCategory({
  node,
  venue,
  current,
  productCount,
  onClose,
}: {
  node: Node;
  venue: ReturnType<typeof useStations>;
  current: string[];
  productCount: number;
  onClose: () => void;
}) {
  const [sel, setSel] = useState<string[]>(current);
  const [apply, setApply] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="sheet-bg" {...backdrop(onClose)}>
      <div className="sheet center" role="dialog" aria-modal="true">
        <h3>¿A dónde se envía "{node.name}"?</h3>
        <p className="small">
          Los productos nuevos de esta categoría se enviarán aquí sin tener que elegirlo cada vez.
        </p>
        <StationPicker
          value={sel}
          onChange={setSel}
          areas={venue.areas}
          stations={venue.stations}
        />
        <button
          type="button"
          className={`opt ${apply ? "on" : ""}`}
          style={{ textAlign: "left" }}
          onClick={() => setApply(!apply)}
        >
          {apply ? "✓ " : ""}Aplicar también a los {productCount} producto(s) que ya están en la
          categoría
        </button>
        {err && <p className="err">{err}</p>}
        <button
          type="button"
          className="btn primary"
          onClick={() =>
            api(`/api/categories/${node.id}/routes`, {
              method: "PUT",
              body: { station_ids: sel, apply_to_products: apply },
            }).then(onClose, (e) => setErr((e as Error).message))
          }
        >
          Guardar destino
        </button>
      </div>
    </div>
  );
}

/** Productos: crear y editar con categoría y destino (hereda el de la categoría si no se elige). */
export function Products() {
  const products = useLive(() => api<Product[]>("/api/products"), ["product.updated"]);
  const cats = useLive(() => api<Category[]>("/api/categories"), []);
  const routes = useLive(() => api<CategoryRoute[]>("/api/category-routes"), []);
  const venue = useStations();
  const [form, setForm] = useState<{
    id: string | null;
    name: string;
    price: string;
    category: string;
    stationIds: string[];
  }>({ id: null, name: "", price: "", category: "", stationIds: [] });
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // Foto: la que ya tiene el producto, la nueva elegida (aún sin subir) o quitarla
  const [photo, setPhoto] = useState<{
    current: string | null;
    pending: string | null;
    remove: boolean;
  }>({ current: null, pending: null, remove: false });
  const tree = flattenCategories(cats.data ?? []);
  const catPath = (id: string | null) => tree.find((c) => c.id === id)?.path ?? "Sin categoría";
  const price = Math.round((parseFloat(form.price.replace(",", ".")) || 0) * 100);

  // Destino heredado de la categoría elegida (o de sus padres)
  const inherited = (() => {
    let cur: string | null = form.category || null;
    for (let i = 0; cur && i < 5; i++) {
      const ids = (routes.data ?? []).filter((r) => r.category_id === cur).map((r) => r.station_id);
      if (ids.length) return venue.stations.filter((s) => ids.includes(s.id)).map((s) => s.label);
      cur = (cats.data ?? []).find((c) => c.id === cur)?.parent_id ?? null;
    }
    return [] as string[];
  })();

  const reset = () => {
    setForm({ id: null, name: "", price: "", category: form.category, stationIds: [] });
    setPhoto({ current: null, pending: null, remove: false });
    setOpen(false);
  };
  const pickPhoto = (file: File | undefined) => {
    if (!file) return;
    resizeImage(file).then(
      (data) => setPhoto((p) => ({ ...p, pending: data, remove: false })),
      (e) => setErr((e as Error).message),
    );
  };
  const save = () => {
    const body = {
      name: form.name.trim(),
      price_cents: price,
      category_id: form.category || null,
      station_ids: form.stationIds,
    };
    const req = form.id
      ? api(`/api/products/${form.id}`, {
          method: "PATCH",
          body: { ...body, station_ids: form.stationIds.length ? form.stationIds : undefined },
        })
      : api("/api/products", { body });
    req
      .then(async (r) => {
        const id = form.id ?? (r as { id: string }).id;
        if (photo.pending)
          await api(`/api/products/${id}/photo`, { body: { data: photo.pending } });
        else if (photo.remove && photo.current)
          await api(`/api/products/${id}/photo`, { method: "DELETE" });
      })
      .then(
        () => {
          setErr(null);
          reset();
          products.reload();
        },
        (e) => setErr((e as Error).message),
      );
  };

  return (
    <div className="split">
      <section className="card fillcard">
        <div className="row spread" style={{ flex: "none" }}>
          <span className="small">
            {(products.data ?? []).length} productos · cada uno se envía a la estación que elijas, o
            a la de su categoría
          </span>
          <button
            type="button"
            className="btn primary"
            style={{ minHeight: 48 }}
            onClick={() => setOpen(true)}
          >
            + Nuevo producto
          </button>
        </div>
        {err && !open && <p className="err">{err}</p>}
        <PagedRows
          items={products.data ?? []}
          rowH={52}
          empty={<p className="muted">Aún no hay productos</p>}
          head={
            <tr>
              <th>Producto</th>
              <th>Categoría</th>
              <th>Se envía a</th>
              <th className="r">Precio</th>
              <th />
            </tr>
          }
          row={(p) => (
            <>
              <td className="ellipsis" style={{ maxWidth: 200 }}>
                <span className="row" style={{ gap: 8 }}>
                  {photoSrc(p.photo) ? (
                    <img
                      src={photoSrc(p.photo)!}
                      alt=""
                      style={{
                        width: 36,
                        height: 36,
                        objectFit: "cover",
                        borderRadius: 6,
                        flex: "none",
                      }}
                    />
                  ) : (
                    <span
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 6,
                        background: "var(--color-fog)",
                        flex: "none",
                      }}
                    />
                  )}
                  <span className="ellipsis">{p.name}</span>
                </span>
              </td>
              <td className="small ellipsis" style={{ maxWidth: 150 }}>
                {catPath(p.category_id)}
              </td>
              <td className="small ellipsis" style={{ maxWidth: 150 }}>
                {venue.stations
                  .filter((s) => p.station_ids.includes(s.id))
                  .map((s) => s.label)
                  .join(", ") || "—"}
              </td>
              <td className="r num">{money(p.price_cents)}</td>
              <td className="r">
                <div className="row" style={{ justifyContent: "flex-end", gap: 4 }}>
                  <button
                    type="button"
                    className="btn ghost sm"
                    title="Marcar agotado / disponible"
                    onClick={() =>
                      api(`/api/products/${p.id}/availability`, {
                        body: {
                          availability: p.availability === "agotado" ? "disponible" : "agotado",
                        },
                      }).then(
                        () => products.reload(),
                        (e) => setErr((e as Error).message),
                      )
                    }
                  >
                    {p.availability === "agotado" ? "Agotado" : "Agotar"}
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      setForm({
                        id: p.id,
                        name: p.name,
                        price: (p.price_cents / 100).toFixed(2),
                        category: p.category_id ?? "",
                        stationIds: p.station_ids,
                      });
                      setPhoto({ current: p.photo ?? null, pending: null, remove: false });
                      setOpen(true);
                    }}
                  >
                    Editar
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() =>
                      api(`/api/products/${p.id}`, { method: "DELETE" }).then(
                        () => {
                          setErr(null);
                          products.reload();
                        },
                        (e) => setErr((e as Error).message),
                      )
                    }
                  >
                    ✕
                  </button>
                </div>
              </td>
            </>
          )}
        />
      </section>
      {open && (
        <div className="sheet-bg" {...backdrop(reset)}>
          <div className="sheet center" style={{ width: "min(520px, 100%)" }}>
            <h3>{form.id ? "Editar producto" : "Nuevo producto"}</h3>
            <input
              placeholder="Nombre (Coca, Taco de calamar, Mojito…)"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <div className="row">
              <input
                className="grow"
                placeholder="Precio"
                inputMode="decimal"
                value={form.price}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
              />
              <select
                className="grow"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
              >
                <option value="">Categoría…</option>
                {tree.map((c) => (
                  <option key={c.id} value={c.id}>
                    {"— ".repeat(c.depth)}
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="row" style={{ gap: 10 }}>
              <div
                style={{
                  width: 84,
                  height: 84,
                  borderRadius: 10,
                  background: "var(--color-fog)",
                  overflow: "hidden",
                  flex: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {(photo.pending ?? (photo.remove ? null : photoSrc(photo.current))) ? (
                  <img
                    src={(photo.pending ?? photoSrc(photo.current))!}
                    alt="Foto del platillo"
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                ) : (
                  <Icon name="camara" size={30} />
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
                  Tomar foto
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    hidden
                    onChange={(e) => {
                      pickPhoto(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
                <label
                  className="btn sm"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                  }}
                >
                  Elegir de la galería
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => {
                      pickPhoto(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
                {(photo.pending || (photo.current && !photo.remove)) && (
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => setPhoto({ ...photo, pending: null, remove: true })}
                  >
                    Quitar foto
                  </button>
                )}
              </div>
            </div>
            <div className="small">Se prepara en:</div>
            <StationPicker
              value={form.stationIds}
              onChange={(ids) => setForm({ ...form, stationIds: ids })}
              areas={venue.areas}
              stations={venue.stations}
            />
            {form.stationIds.length === 0 && (
              <p className="small">
                {inherited.length
                  ? `Sin elegir: va a ${inherited.join(", ")} (destino de su categoría).`
                  : "Elige una estación, o define el destino de la categoría."}
              </p>
            )}
            {err && <p className="err">{err}</p>}
            <div className="row">
              <button type="button" className="btn grow" onClick={reset}>
                Cancelar
              </button>
              <button
                type="button"
                className="btn primary grow"
                disabled={
                  !form.name.trim() ||
                  !price ||
                  (form.stationIds.length === 0 && inherited.length === 0 && !form.id)
                }
                onClick={save}
              >
                {form.id ? "Guardar cambios" : "Crear producto"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
