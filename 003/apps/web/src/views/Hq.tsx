import { useEffect, useState } from "react";
import { backdrop } from "../sheet";
import { PagedRows, SubTabs } from "../fit";
import { money } from "../api";

/** Consola de la nube (HQ): una organización ve sus sucursales, ventas consolidadas y catálogo maestro. */
const KEY = "003.hq-token";
let token: string | null = sessionStorage.getItem(KEY);

async function hq<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message ?? data?.error ?? "Error");
  return data as T;
}

interface Me {
  name: string;
  plan: string;
  role: string;
  branches_used: number;
  limits: {
    branches: number | null;
    users: number | null;
    printers: number | null;
    features: string[];
  };
}
interface Branch {
  id: string;
  name: string;
  last_seen: number | null;
  active: number;
  /** El equipo ya canjeó su código de activación. */
  activated: boolean;
  fingerprint_short: string | null;
  backups: number;
  last_backup: number | null;
  backup_bytes: number;
  backup_quota_bytes: number;
}
interface BackupFile {
  name: string;
  size: number;
  created_at: number;
}
interface ActivationCode {
  code: string;
  expires_at: number;
  branch: string;
}
interface Summary {
  branches: {
    id: string;
    name: string;
    tickets: number;
    sales_cents: number;
    tips_cents: number;
    discounts_cents: number;
    cancelled_items: number;
  }[];
  total: { tickets: number; sales_cents: number; tips_cents: number; average_ticket_cents: number };
}
interface CatalogRow {
  sku: string;
  name: string;
  price_cents: number;
  category: string | null;
  station_names: string[];
  active: number;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

const dayStr = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const DAY = 86_400_000;
type Tab = "resumen" | "sucursales" | "catalogo";

export function Hq() {
  const [authed, setAuthed] = useState(!!token);
  if (!authed) return <HqLogin onLogin={() => setAuthed(true)} />;
  return (
    <HqHome
      onLogout={() => {
        token = null;
        sessionStorage.removeItem(KEY);
        setAuthed(false);
      }}
    />
  );
}

function HqLogin({ onLogin }: { onLogin: () => void }) {
  const [f, setF] = useState({ username: "", password: "" });
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="login"
      onSubmit={(e) => {
        e.preventDefault();
        hq<{ token: string }>("/api/hq/login", { body: f }).then(
          (r) => {
            token = r.token;
            sessionStorage.setItem(KEY, r.token);
            onLogin();
          },
          () => setErr("Usuario o contraseña incorrectos"),
        );
      }}
    >
      <div>
        <h2>Nodo · Nube</h2>
        <p className="small">Acceso de la organización</p>
      </div>
      <input
        placeholder="Usuario"
        autoCapitalize="none"
        value={f.username}
        onChange={(e) => setF({ ...f, username: e.target.value })}
      />
      <input
        placeholder="Contraseña"
        type="password"
        value={f.password}
        onChange={(e) => setF({ ...f, password: e.target.value })}
      />
      {err && <p className="err">{err}</p>}
      <button className="btn primary" type="submit">
        Entrar
      </button>
    </form>
  );
}

function HqHome({ onLogout }: { onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>("resumen");
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    hq<Me>("/api/hq/me").then(setMe, onLogout);
  }, [onLogout]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="shell">
      <div className="status-bar">
        <span>{me?.name}</span>
        <span className="grow" />
        <span>
          plan {me?.plan} · {me?.branches_used}/{me?.limits.branches ?? "∞"} sucursales
        </span>
        <button
          type="button"
          className="btn ghost"
          style={{ color: "#fff", minHeight: 24, padding: "0 8px" }}
          onClick={onLogout}
        >
          Salir
        </button>
      </div>
      <main className="main">
        <div className="view">
          <SubTabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "resumen", label: "Resumen" },
              { id: "sucursales", label: "Sucursales" },
              { id: "catalogo", label: "Catálogo maestro" },
            ]}
          />
          {tab === "resumen" && <HqSummary />}
          {tab === "sucursales" && <HqBranches owner={me?.role === "owner"} />}
          {tab === "catalogo" && <HqCatalog owner={me?.role === "owner"} />}
        </div>
      </main>
    </div>
  );
}

function HqSummary() {
  const [span, setSpan] = useState<"1" | "7" | "30">("7");
  const [s, setS] = useState<Summary | null>(null);
  useEffect(() => {
    const from = dayStr(Date.now() - (Number(span) - 1) * DAY);
    hq<Summary>(`/api/hq/reports/summary?from=${from}&to=${dayStr(Date.now())}`).then(setS, () =>
      setS(null),
    );
  }, [span]);
  return (
    <>
      <div className="row spread" style={{ flex: "none" }}>
        {s && (
          <div className="stats" style={{ flex: 1, gridTemplateColumns: "repeat(4, 1fr)" }}>
            <div className="card stat" style={{ padding: 12 }}>
              <div className="small">Ventas</div>
              <div className="v num" style={{ fontSize: 24 }}>
                {money(s.total.sales_cents)}
              </div>
            </div>
            <div className="card stat" style={{ padding: 12 }}>
              <div className="small">Tickets</div>
              <div className="v num" style={{ fontSize: 24 }}>
                {s.total.tickets}
              </div>
            </div>
            <div className="card stat" style={{ padding: 12 }}>
              <div className="small">Ticket promedio</div>
              <div className="v num" style={{ fontSize: 24 }}>
                {money(s.total.average_ticket_cents)}
              </div>
            </div>
            <div className="card stat" style={{ padding: 12 }}>
              <div className="small">Propinas</div>
              <div className="v num" style={{ fontSize: 24 }}>
                {money(s.total.tips_cents)}
              </div>
            </div>
          </div>
        )}
        <SubTabs
          value={span}
          onChange={setSpan}
          tabs={[
            { id: "1", label: "Hoy" },
            { id: "7", label: "7 días" },
            { id: "30", label: "30 días" },
          ]}
        />
      </div>
      <section className="card fillcard">
        <PagedRows
          items={s?.branches ?? []}
          rowH={52}
          empty={<p className="muted">Aún no hay ventas sincronizadas</p>}
          head={
            <tr>
              <th>Sucursal</th>
              <th className="r">Tickets</th>
              <th className="r">Ventas</th>
              <th className="r">Propinas</th>
              <th className="r">Descuentos</th>
              <th className="r">Cancelaciones</th>
            </tr>
          }
          row={(b) => (
            <>
              <td>{b.name}</td>
              <td className="r num">{b.tickets}</td>
              <td className="r num">{money(b.sales_cents)}</td>
              <td className="r num">{money(b.tips_cents)}</td>
              <td className="r num">{money(b.discounts_cents)}</td>
              <td className="r num">{b.cancelled_items}</td>
            </>
          )}
        />
      </section>
    </>
  );
}

function HqBranches({ owner }: { owner: boolean }) {
  const [list, setList] = useState<Branch[]>([]);
  const [name, setName] = useState("");
  const [code, setCode] = useState<ActivationCode | null>(null);
  const [files, setFiles] = useState<Branch | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => hq<Branch[]>("/api/hq/branches").then(setList, () => undefined);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="split">
      <section className="card fillcard">
        {err && <p className="err">{err}</p>}
        <PagedRows
          items={list}
          rowH={52}
          head={
            <tr>
              <th>Sucursal</th>
              <th>Equipo</th>
              <th>Respaldos</th>
              <th>Última conexión</th>
              <th />
            </tr>
          }
          row={(b) => (
            <>
              <td>{b.name}</td>
              <td className="small">
                {b.activated ? <span className="num">{b.fingerprint_short}</span> : "sin activar"}
              </td>
              <td className="small">
                {b.backups ? (
                  <button type="button" className="btn ghost sm" onClick={() => setFiles(b)}>
                    {b.backups} · {mb(b.backup_bytes)} de {mb(b.backup_quota_bytes)}
                  </button>
                ) : (
                  "ninguno"
                )}
              </td>
              <td className="small">
                {b.last_seen
                  ? new Date(b.last_seen).toLocaleString("es-MX", { hour12: false })
                  : "nunca"}
              </td>
              <td className="r">
                {owner && (
                  <button
                    type="button"
                    className="btn ghost sm"
                    title="Emite un código de activación nuevo (equipo nuevo o código perdido)"
                    onClick={() =>
                      hq<{ code: string; expires_at: number }>(
                        `/api/hq/branches/${b.id}/activation-code`,
                        { method: "POST", body: {} },
                      ).then(
                        (r) => setCode({ ...r, branch: b.name }),
                        (e) => setErr((e as Error).message),
                      )
                    }
                  >
                    Código nuevo
                  </button>
                )}
                {owner && (
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() =>
                      hq(`/api/hq/branches/${b.id}`, {
                        method: "PATCH",
                        body: { active: !b.active },
                      }).then(load, (e) => setErr((e as Error).message))
                    }
                  >
                    {b.active ? "Activa" : "Desactivada"}
                  </button>
                )}
              </td>
            </>
          )}
        />
      </section>
      {owner && (
        <section className="card col" style={{ width: 340, flex: "none" }}>
          <h3>Nueva sucursal</h3>
          <input placeholder="Nombre" value={name} onChange={(e) => setName(e.target.value)} />
          <button
            type="button"
            className="btn primary"
            disabled={!name}
            onClick={() =>
              hq<{ activation_code: string; activation_expires_at: number }>("/api/hq/branches", {
                body: { name },
              }).then(
                (r) => {
                  setCode({
                    code: r.activation_code,
                    expires_at: r.activation_expires_at,
                    branch: name,
                  });
                  setName("");
                  setErr(null);
                  void load();
                },
                (e) => setErr((e as Error).message),
              )
            }
          >
            Crear sucursal
          </button>
          <p className="small">
            Cada sucursal se activa con un código de un solo uso en Configuración → Nube y plan.
          </p>
        </section>
      )}
      {files && (
        <BackupList
          branch={files}
          owner={owner}
          onClose={() => {
            setFiles(null);
            void load();
          }}
        />
      )}
      {code && (
        <div className="sheet-bg" {...backdrop(() => setCode(null))}>
          <div className="sheet center" role="dialog" aria-modal="true">
            <h3>Código de activación de {code.branch}</h3>
            <p className="small">
              Se escribe una sola vez en Configuración → Nube y plan del equipo del local (con
              Internet). Vale hasta el{" "}
              {new Date(code.expires_at).toLocaleDateString("es-MX", { dateStyle: "long" })}. Al
              canjearlo, el equipo anterior de esta sucursal deja de poder usar su licencia.
            </p>
            <input
              readOnly
              value={code.code}
              onFocus={(e) => e.currentTarget.select()}
              style={{ fontFamily: "ui-monospace, monospace", fontSize: 20, letterSpacing: 1 }}
            />
            <button type="button" className="btn primary" onClick={() => setCode(null)}>
              Listo
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function HqCatalog({ owner }: { owner: boolean }) {
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [f, setF] = useState({ sku: "", name: "", price: "", category: "", stations: "" });
  const [err, setErr] = useState<string | null>(null);
  const load = () => hq<CatalogRow[]>("/api/hq/catalog").then(setRows, () => undefined);
  useEffect(() => {
    void load();
  }, [load]);
  const price = Math.round((parseFloat(f.price.replace(",", ".")) || 0) * 100);
  return (
    <div className="split">
      <section className="card fillcard">
        <PagedRows
          items={rows}
          rowH={48}
          empty={<p className="muted">El catálogo maestro está vacío</p>}
          head={
            <tr>
              <th>SKU</th>
              <th>Producto</th>
              <th>Categoría</th>
              <th>Estaciones</th>
              <th className="r">Precio</th>
            </tr>
          }
          row={(r) => (
            <>
              <td className="num">{r.sku}</td>
              <td>{r.name}</td>
              <td className="small">{r.category}</td>
              <td className="small">{r.station_names.join(", ")}</td>
              <td className="r num">{money(r.price_cents)}</td>
            </>
          )}
        />
      </section>
      {owner && (
        <section className="card col" style={{ width: 340, flex: "none" }}>
          <h3>Producto del catálogo</h3>
          <input
            placeholder="SKU"
            value={f.sku}
            onChange={(e) => setF({ ...f, sku: e.target.value })}
          />
          <input
            placeholder="Nombre"
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
          />
          <div className="row">
            <input
              className="grow"
              placeholder="Precio"
              inputMode="decimal"
              value={f.price}
              onChange={(e) => setF({ ...f, price: e.target.value })}
            />
            <input
              className="grow"
              placeholder="Categoría"
              value={f.category}
              onChange={(e) => setF({ ...f, category: e.target.value })}
            />
          </div>
          <input
            placeholder="Estaciones (nombres, separados por coma)"
            value={f.stations}
            onChange={(e) => setF({ ...f, stations: e.target.value })}
          />
          {err && <p className="err">{err}</p>}
          <button
            type="button"
            className="btn primary"
            disabled={!f.sku || !f.name || !price}
            onClick={() =>
              hq("/api/hq/catalog", {
                method: "PUT",
                body: {
                  products: [
                    {
                      sku: f.sku,
                      name: f.name,
                      price_cents: price,
                      category: f.category || null,
                      station_names: f.stations
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    },
                  ],
                },
              }).then(
                () => {
                  setF({
                    sku: "",
                    name: "",
                    price: "",
                    category: f.category,
                    stations: f.stations,
                  });
                  setErr(null);
                  void load();
                },
                (e) => setErr((e as Error).message),
              )
            }
          >
            Guardar y distribuir
          </button>
          <p className="small">
            Cada sucursal descarga el catálogo al sincronizar. Las estaciones se buscan por nombre
            en cada local.
          </p>
        </section>
      )}
    </div>
  );
}

/** Respaldos de una sucursal: están cifrados con una clave que solo tiene el cliente (el HQ no puede abrirlos). */
function BackupList({
  branch,
  owner,
  onClose,
}: {
  branch: Branch;
  owner: boolean;
  onClose: () => void;
}) {
  const [list, setList] = useState<BackupFile[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const base = `/api/hq/branches/${branch.id}/backups`;
  const load = () => hq<BackupFile[]>(base).then(setList, (e) => setErr((e as Error).message));
  useEffect(() => {
    void load();
    // biome-ignore lint/correctness/useExhaustiveDependencies: se carga al abrir
  }, [load]);
  const download = async (f: BackupFile) => {
    try {
      const r = await fetch(`${base}/${f.name}`, {
        headers: { Authorization: `Bearer ${token ?? ""}` },
      });
      if (!r.ok) throw new Error(`No se pudo descargar (${r.status})`);
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = f.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="sheet-bg" {...backdrop(onClose)}>
      <div className="sheet center" role="dialog" aria-modal="true">
        <h3>Respaldos de {branch.name}</h3>
        <p className="small">
          Usa {mb(branch.backup_bytes)} de {mb(branch.backup_quota_bytes)}. Están cifrados con una
          clave que solo tiene el cliente: Nodo no puede abrirlos.
        </p>
        {err && <p className="err">{err}</p>}
        {list.map((f) => (
          <div key={f.name} className="row spread" style={{ gap: 8 }}>
            <span className="small">
              {new Date(f.created_at).toLocaleString("es-MX", { hour12: false })} · {mb(f.size)}
            </span>
            <span className="row" style={{ gap: 6 }}>
              <button type="button" className="btn ghost sm" onClick={() => download(f)}>
                Descargar
              </button>
              {owner && (
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() =>
                    hq(`${base}/${f.name}`, { method: "DELETE" }).then(load, (e) =>
                      setErr((e as Error).message),
                    )
                  }
                >
                  Borrar
                </button>
              )}
            </span>
          </div>
        ))}
        <button type="button" className="btn primary" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </div>
  );
}
