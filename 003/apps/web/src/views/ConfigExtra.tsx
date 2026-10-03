import { DeleteButton } from "../ui";
import { useEffect, useState } from "react";
import { backdrop } from "../sheet";
import QRCode from "qrcode";
import { api, money, serverBase, useLive } from "../api";
import { PagedGrid, PagedRows } from "../fit";

interface Promo {
  id: string;
  name: string;
  kind: string;
  value: number;
  days: string | null;
  start_minute: number | null;
  end_minute: number | null;
  active: number;
  product_id: string | null;
}
interface Product {
  id: string;
  name: string;
}

const DAYS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const hhmm = (m: number | null) =>
  m === null
    ? ""
    : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const minutes = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export function Promotions() {
  const promos = useLive(() => api<Promo[]>("/api/promotions"), []);
  const products = useLive(() => api<Product[]>("/api/products"), []);
  const [f, setF] = useState({
    name: "",
    kind: "porcentaje",
    value: "",
    product: "",
    days: [] as number[],
    from: "",
    to: "",
  });
  const [err, setErr] = useState<string | null>(null);
  const needsValue = f.kind !== "2x1";
  const valueLabel =
    f.kind === "porcentaje"
      ? "% de descuento"
      : f.kind === "monto"
        ? "Monto ($)"
        : "Precio especial ($)";
  const value =
    f.kind === "porcentaje"
      ? Math.round(Number(f.value) || 0)
      : Math.round((parseFloat(f.value.replace(",", ".")) || 0) * 100);
  const toggleDay = (d: number) =>
    setF((s) => ({
      ...s,
      days: s.days.includes(d) ? s.days.filter((x) => x !== d) : [...s.days, d].sort(),
    }));

  const save = () =>
    api("/api/promotions", {
      body: {
        name: f.name,
        kind: f.kind,
        value: needsValue ? value : 0,
        product_id: f.product || null,
        days: f.days.length ? f.days.join(",") : null,
        start_minute: f.from && f.to ? minutes(f.from) : null,
        end_minute: f.from && f.to ? minutes(f.to) : null,
      },
    }).then(
      () => {
        setF({ ...f, name: "", value: "" });
        promos.reload();
        setErr(null);
      },
      (e) => setErr((e as Error).message),
    );

  return (
    <div className="split">
      <section className="card fillcard">
        <PagedRows
          items={promos.data ?? []}
          rowH={60}
          empty={<p className="muted">Aún no hay promociones</p>}
          row={(p) => (
            <td style={{ padding: 0 }}>
              <div className="row spread" style={{ height: 60 }}>
                <span className="ellipsis">
                  {p.name}
                  <div className="small ellipsis">
                    {p.kind}
                    {p.kind === "porcentaje" ? ` ${p.value}%` : p.value ? ` ${money(p.value)}` : ""}
                    {p.days
                      ? ` · ${p.days
                          .split(",")
                          .map((d) => DAYS[Number(d)])
                          .join(" ")}`
                      : ""}
                    {p.start_minute !== null
                      ? ` · ${hhmm(p.start_minute)}–${hhmm(p.end_minute)}`
                      : ""}
                  </div>
                </span>
                <div className="row">
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() =>
                      api(`/api/promotions/${p.id}`, {
                        method: "PATCH",
                        body: { active: !p.active },
                      }).then(() => promos.reload())
                    }
                  >
                    {p.active ? "Activa" : "Pausada"}
                  </button>
                  <DeleteButton
                    what={`la promoción «${p.name}»`}
                    onConfirm={() =>
                      api(`/api/promotions/${p.id}`, { method: "DELETE" }).then(() =>
                        promos.reload(),
                      )
                    }
                  />
                </div>
              </div>
            </td>
          )}
        />
      </section>
      <section className="card col" style={{ width: 360, flex: "none", alignSelf: "flex-start" }}>
        <input
          placeholder="Nueva promoción: nombre (Happy hour, 2x1…)"
          value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value })}
        />
        <div className="row">
          <select
            className="grow"
            value={f.kind}
            onChange={(e) => setF({ ...f, kind: e.target.value })}
          >
            <option value="porcentaje">Porcentaje</option>
            <option value="monto">Monto fijo</option>
            <option value="2x1">2x1</option>
            <option value="precio_especial">Precio especial</option>
          </select>
          {needsValue && (
            <input
              style={{ width: 110 }}
              placeholder={valueLabel}
              inputMode="decimal"
              value={f.value}
              onChange={(e) => setF({ ...f, value: e.target.value })}
            />
          )}
        </div>
        <select value={f.product} onChange={(e) => setF({ ...f, product: e.target.value })}>
          <option value="">Todos los productos</option>
          {products.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="row" style={{ gap: 4 }}>
          {DAYS.map((d, i) => (
            <button
              type="button"
              key={d}
              className={`opt grow ${f.days.includes(i) ? "on" : ""}`}
              style={{ minHeight: 40, padding: 0, fontSize: 13 }}
              onClick={() => toggleDay(i)}
            >
              {d}
            </button>
          ))}
        </div>
        <div className="row">
          <input
            className="grow"
            type="time"
            value={f.from}
            onChange={(e) => setF({ ...f, from: e.target.value })}
          />
          <input
            className="grow"
            type="time"
            value={f.to}
            onChange={(e) => setF({ ...f, to: e.target.value })}
          />
        </div>
        {err && <p className="err">{err}</p>}
        <button
          type="button"
          className="btn primary"
          disabled={!f.name || (needsValue && !value)}
          onClick={save}
        >
          Crear promoción
        </button>
      </section>
    </div>
  );
}

/** QR por mesa: el administrador lo imprime y lo pega en la mesa. */
export function QrCodes() {
  const tables = useLive(() => api<{ id: string; number: string }[]>("/api/tables"), []);
  const [show, setShow] = useState<{ number: string; url: string; img: string } | null>(null);

  const open = async (t: { id: string; number: string }) => {
    const { path } = await api<{ path: string }>(`/api/tables/${t.id}/qr`);
    // En el equipo del servidor la página se abre como "localhost", pero la tablet necesita la IP de la red local
    let origin = serverBase() || location.origin;
    if (["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) {
      const net = await api<{ port: number; addresses: string[] }>("/api/network").catch(
        () => null,
      );
      if (net?.addresses[0]) origin = `http://${net.addresses[0]}:${net.port}`;
    }
    const url = `${origin}${path}`;
    setShow({ number: t.number, url, img: await QRCode.toDataURL(url, { margin: 1, width: 360 }) });
  };

  useEffect(() => {
    if (!show) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setShow(null);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [show]);

  return (
    <section className="card fillcard">
      <p className="small">
        Elige una mesa para generar su QR. Las tablets y teléfonos deben estar en la misma red del
        local.
      </p>
      <PagedGrid
        items={tables.data ?? []}
        minW={110}
        minH={56}
        gap={8}
        render={(t) => (
          <button type="button" className="opt" style={{ height: "100%" }} onClick={() => open(t)}>
            Mesa {t.number}
          </button>
        )}
      />
      {show && (
        <div className="sheet-bg" {...backdrop(() => setShow(null))}>
          <div className="sheet center" style={{ alignItems: "center" }}>
            <h2>Mesa {show.number}</h2>
            <img src={show.img} width={240} height={240} alt={`QR mesa ${show.number}`} />
            <p className="small" style={{ wordBreak: "break-all", userSelect: "text" }}>
              {show.url}
            </p>
            <div className="row">
              <button type="button" className="btn" onClick={() => window.print()}>
                Imprimir
              </button>
              <button type="button" className="btn primary" onClick={() => setShow(null)}>
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
