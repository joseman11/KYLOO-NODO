import { useState } from "react";
import { api, useLive } from "../api";
import { PagedRows } from "../fit";

interface Integration {
  id: string;
  name: string;
  kind: string;
  active: number;
}
interface Webhook {
  id: string;
  url: string;
  events: string;
  active: number;
  failed: number;
  pending: number;
}
interface CloudStatus {
  linked: boolean;
  url: string | null;
  last_sync: number | null;
  license: {
    plan: string;
    expires_at: number;
    expired: boolean;
    features: string[];
    limits: { users: number | null; printers: number | null };
  } | null;
  usage: { users: number; printers: number };
}
interface SyncReport {
  sales: { ok: boolean; days?: number; error?: string };
  license: { ok: boolean; plan?: string; error?: string };
  catalog: {
    ok: boolean;
    created?: number;
    updated?: number;
    skipped?: { sku: string; reason: string }[];
    error?: string;
  };
}

const EVENTS = [
  "order.created",
  "ticket.updated",
  "delivery.updated",
  "payment.created",
  "inventory.alert",
  "invoice.issued",
] as const;
const KINDS = [
  ["web", "Página web"],
  ["whatsapp", "WhatsApp"],
  ["delivery_app", "App de delivery"],
  ["otro", "Otro"],
] as const;

/** Muestra un secreto una sola vez: el servidor solo guarda su huella. */
function SecretSheet({
  title,
  value,
  onClose,
}: {
  title: string;
  value: string;
  onClose: () => void;
}) {
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet center" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p className="small">Cópiala ahora: no se volverá a mostrar.</p>
        <input
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}
        />
        <button className="btn primary" onClick={onClose}>
          Ya la guardé
        </button>
      </div>
    </div>
  );
}

export function Integrations() {
  const integ = useLive(() => api<Integration[]>("/api/integrations"), []);
  const hooks = useLive(() => api<Webhook[]>("/api/webhooks"), []);
  const [form, setForm] = useState({ name: "", kind: "delivery_app" });
  const [hook, setHook] = useState<{ url: string; events: string[] }>({ url: "", events: [] });
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fail = (e: unknown) => setErr((e as Error).message);

  return (
    <div className="split">
      <section className="card fillcard">
        <h3>Pedidos por API (web, WhatsApp, apps de delivery)</h3>
        <p className="small">
          Cada integración recibe una llave. Envía los pedidos a POST /api/integrations/orders con
          el encabezado x-api-key y los productos por SKU.
        </p>
        {err && <p className="err">{err}</p>}
        <PagedRows
          items={integ.data ?? []}
          rowH={52}
          empty={<p className="muted">Sin integraciones</p>}
          row={(i) => (
            <td style={{ padding: 0 }}>
              <div className="row spread" style={{ height: 52 }}>
                <span className="ellipsis">
                  {i.name} <span className="tag">{KINDS.find((k) => k[0] === i.kind)?.[1]}</span>
                </span>
                <button
                  className="btn sm"
                  onClick={() =>
                    api(`/api/integrations/${i.id}`, {
                      method: "PATCH",
                      body: { active: !i.active },
                    }).then(() => integ.reload(), fail)
                  }
                >
                  {i.active ? "Activa" : "Pausada"}
                </button>
              </div>
            </td>
          )}
        />
        <div className="row" style={{ flex: "none" }}>
          <input
            className="grow"
            placeholder="Nombre (Rappi, web…)"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            {KINDS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <button
            className="btn primary"
            style={{ minHeight: 48 }}
            disabled={!form.name}
            onClick={() =>
              api<{ api_key: string }>("/api/integrations", { body: form }).then((r) => {
                setSecret({ title: `Llave de ${form.name}`, value: r.api_key });
                setForm({ ...form, name: "" });
                integ.reload();
              }, fail)
            }
          >
            Crear
          </button>
        </div>
      </section>

      <section className="card fillcard">
        <h3>Webhooks (avisos a otros sistemas)</h3>
        <p className="small">
          Cada aviso va firmado (x-003-signature, HMAC-SHA256) y se reintenta si el destino no
          responde.
        </p>
        <PagedRows
          items={hooks.data ?? []}
          rowH={60}
          empty={<p className="muted">Sin webhooks</p>}
          row={(h) => (
            <td style={{ padding: 0 }}>
              <div className="row spread" style={{ height: 60 }}>
                <div style={{ minWidth: 0 }}>
                  <div className="ellipsis">{h.url}</div>
                  <div className="small ellipsis">
                    {h.events === "*" ? "todos los eventos" : h.events}
                    {h.pending ? ` · ${h.pending} pendientes` : ""}
                    {h.failed ? ` · ${h.failed} con error` : ""}
                  </div>
                </div>
                <button
                  className="btn ghost sm"
                  onClick={() =>
                    api(`/api/webhooks/${h.id}`, { method: "DELETE" }).then(
                      () => hooks.reload(),
                      fail,
                    )
                  }
                >
                  Eliminar
                </button>
              </div>
            </td>
          )}
        />
        <input
          placeholder="https://mi-sistema.com/hook"
          value={hook.url}
          onChange={(e) => setHook({ ...hook, url: e.target.value })}
        />
        <div className="row wrap" style={{ flex: "none" }}>
          {EVENTS.map((ev) => (
            <button
              key={ev}
              className={`opt ${hook.events.includes(ev) ? "on" : ""}`}
              style={{ minHeight: 40, padding: "0 10px", fontSize: 13 }}
              onClick={() =>
                setHook({
                  ...hook,
                  events: hook.events.includes(ev)
                    ? hook.events.filter((x) => x !== ev)
                    : [...hook.events, ev],
                })
              }
            >
              {ev}
            </button>
          ))}
        </div>
        <button
          className="btn primary"
          style={{ flex: "none" }}
          disabled={!hook.url}
          onClick={() =>
            api<{ secret: string }>("/api/webhooks", { body: hook }).then((r) => {
              setSecret({ title: "Secreto del webhook", value: r.secret });
              setHook({ url: "", events: [] });
              hooks.reload();
            }, fail)
          }
        >
          Agregar webhook
        </button>
      </section>
      {secret && <SecretSheet {...secret} onClose={() => setSecret(null)} />}
    </div>
  );
}

const fmtDate = (ts: number | null) =>
  ts ? new Date(ts).toLocaleString("es-MX", { hour12: false }) : "nunca";

export function Cloud() {
  const status = useLive(() => api<CloudStatus>("/api/cloud/status"), []);
  const [form, setForm] = useState({ url: "", key: "" });
  const [report, setReport] = useState<SyncReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const s = status.data;
  const fail = (e: unknown) => setErr((e as Error).message);
  const lim = (n: number | null) => (n === null ? "sin límite" : String(n));

  return (
    <div className="split">
      <section className="card fillcard">
        <h3>Nube (multi-sucursal y plan)</h3>
        <p className="small">
          La sucursal opera siempre en la red local. La nube solo recibe las ventas del día, entrega
          el catálogo maestro y renueva la licencia; si no hay Internet, nada se detiene.
        </p>
        {err && <p className="err">{err}</p>}
        {s?.linked ? (
          <>
            <p>
              Vinculada a <strong>{s.url}</strong>
              <br />
              <span className="small">Última sincronización: {fmtDate(s.last_sync)}</span>
            </p>
            <div className="row" style={{ flex: "none" }}>
              <button
                className="btn primary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setErr(null);
                  api<SyncReport>("/api/cloud/sync", { method: "POST", body: {} })
                    .then((r) => {
                      setReport(r);
                      status.reload();
                    }, fail)
                    .finally(() => setBusy(false));
                }}
              >
                {busy ? "Sincronizando…" : "Sincronizar ahora"}
              </button>
              <button
                className="btn ghost"
                onClick={() =>
                  api("/api/cloud/unlink", { method: "POST", body: {} }).then(() => {
                    setReport(null);
                    status.reload();
                  }, fail)
                }
              >
                Desvincular
              </button>
            </div>
            {report && (
              <div className="small">
                <div>
                  Ventas:{" "}
                  {report.sales.ok
                    ? `${report.sales.days} día(s) enviados`
                    : `error — ${report.sales.error}`}
                </div>
                <div>
                  Licencia:{" "}
                  {report.license.ok
                    ? `plan ${report.license.plan}`
                    : `error — ${report.license.error}`}
                </div>
                <div>
                  Catálogo:{" "}
                  {report.catalog.ok
                    ? `${report.catalog.created} nuevos, ${report.catalog.updated} actualizados${report.catalog.skipped?.length ? `, ${report.catalog.skipped.length} omitidos (sin estación local)` : ""}`
                    : `error — ${report.catalog.error}`}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="col">
            <input
              placeholder="Dirección del HQ (https://…)"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
            />
            <input
              placeholder="Llave de la sucursal (bk_…)"
              value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
            />
            <button
              className="btn primary"
              disabled={!form.url || !form.key}
              onClick={() =>
                api("/api/cloud/link", { body: form }).then(() => status.reload(), fail)
              }
            >
              Vincular sucursal
            </button>
          </div>
        )}
      </section>

      <section className="card fillcard">
        <h3>Plan y licencia</h3>
        {s?.license ? (
          <>
            <p>
              <span className="tag ember">{s.license.plan}</span>{" "}
              {s.license.expired && <span className="err">vencida: renueva la conexión</span>}
            </p>
            <p className="small">Vence: {fmtDate(s.license.expires_at)}</p>
            <table>
              <tbody>
                <tr style={{ height: 40 }}>
                  <td>Usuarios</td>
                  <td className="r num">
                    {s.usage.users} / {lim(s.license.limits.users)}
                  </td>
                </tr>
                <tr style={{ height: 40 }}>
                  <td>Impresoras</td>
                  <td className="r num">
                    {s.usage.printers} / {lim(s.license.limits.printers)}
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="small">
              Funciones incluidas:{" "}
              {s.license.features.length ? s.license.features.join(", ") : "solo las básicas"}
            </p>
          </>
        ) : (
          <p className="muted">
            Sin licencia instalada: instalación propia, sin límites de usuarios, impresoras ni
            funciones.
          </p>
        )}
      </section>
    </div>
  );
}
