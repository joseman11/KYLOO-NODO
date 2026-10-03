import { Hint, StatusChip, type Tone } from "../ui";
import { useState } from "react";
import { backdrop } from "../sheet";
import { api, money, useLive } from "../api";
import { PagedGrid } from "../fit";

interface Row {
  id: string;
  kind: "llevar" | "delivery";
  label: string;
  status: string;
  contact_name: string;
  phone: string | null;
  address: string | null;
  fee_cents: number;
  driver: string | null;
  total_cents: number;
  account_status: string;
  opened_at: number;
}

/** Estado del pedido con palabra, tono e icono (nunca el texto interno «en_camino»). */
const STATUS_TONE: Record<string, { tone: Tone; icon: string; text: string }> = {
  recibido: { tone: "info", icon: "ocupada", text: "Recibido" },
  preparando: { tone: "info", icon: "ocupada", text: "Preparando" },
  listo: { tone: "ok", icon: "check", text: "Listo" },
  en_camino: { tone: "warn", icon: "llevar", text: "En camino" },
  entregado: { tone: "ok", icon: "check", text: "Entregado" },
};

const NEXT: Record<string, { to: string; label: string }[]> = {
  recibido: [{ to: "listo", label: "Marcar listo" }],
  preparando: [{ to: "listo", label: "Marcar listo" }],
  listo: [
    { to: "en_camino", label: "Sale a reparto" },
    { to: "entregado", label: "Entregado" },
  ],
  en_camino: [{ to: "entregado", label: "Entregado" }],
};

/** Pedidos para llevar y delivery: cuentas sin mesa que usan el mismo flujo de comanda y cobro. */
export function External({ onOpen }: { onOpen: (accountId: string) => void }) {
  const list = useLive(
    () => api<Row[]>("/api/delivery"),
    ["delivery.updated", "order.created", "payment.created"],
  );
  const [creating, setCreating] = useState(false);
  const [driverFor, setDriverFor] = useState<Row | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const move = (r: Row, to: string, driver?: string) =>
    api(`/api/delivery/${r.id}/status`, { body: { status: to, driver } }).then(
      () => {
        setDriverFor(null);
        list.reload();
      },
      (e) => setErr((e as Error).message),
    );

  return (
    <div className="view">
      <Hint id="llevar">
        Cada pedido avanza con el botón verde: <strong>Marcar listo</strong>, luego{" "}
        <strong>Sale a reparto</strong> o <strong>Entregado</strong>.
      </Hint>
      <div className="row" style={{ flex: "none", justifyContent: "flex-end" }}>
        <button type="button" className="btn primary" onClick={() => setCreating(true)}>
          Nuevo pedido
        </button>
      </div>
      {err && (
        <p className="err" style={{ flex: "none" }}>
          {err}
        </p>
      )}
      <PagedGrid
        items={list.data ?? []}
        minW={260}
        minH={170}
        empty={<p className="muted">Sin pedidos activos</p>}
        render={(r) => (
          <div
            className={`table-card ${r.status === "listo" ? "esperando_pago" : "ocupada"}`}
            style={{ cursor: "default" }}
          >
            <div className="row spread">
              <span className="n">{r.label}</span>
              <StatusChip
                tone={STATUS_TONE[r.status]?.tone ?? "mute"}
                icon={STATUS_TONE[r.status]?.icon}
              >
                {STATUS_TONE[r.status]?.text ?? r.status}
              </StatusChip>
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="ellipsis">
                <strong>{r.contact_name}</strong> <span className="small">{r.phone}</span>
              </div>
              {r.address && <div className="small ellipsis">{r.address}</div>}
              {r.driver && <div className="small">Repartidor: {r.driver}</div>}
              <div className="num" style={{ fontWeight: 600 }}>
                {money(r.total_cents)}{" "}
                {r.fee_cents > 0 && <span className="small">(envío {money(r.fee_cents)})</span>}
              </div>
            </div>
            <div className="row wrap">
              {r.account_status !== "cerrada" && (
                <button type="button" className="btn sm ghost" onClick={() => onOpen(r.id)}>
                  Ver pedido
                </button>
              )}
              {NEXT[r.status]?.map((n) => (
                <button
                  type="button"
                  key={n.to}
                  className="btn sm ok"
                  onClick={() => (n.to === "en_camino" ? setDriverFor(r) : move(r, n.to))}
                >
                  {n.label}
                </button>
              ))}
            </div>
          </div>
        )}
      />
      {creating && (
        <NewExternal
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            onOpen(id);
          }}
        />
      )}
      {driverFor && (
        <DriverSheet
          onClose={() => setDriverFor(null)}
          onPick={(d) => move(driverFor, "en_camino", d)}
        />
      )}
    </div>
  );
}

function DriverSheet({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (driver: string) => void;
}) {
  const [name, setName] = useState("");
  return (
    <div className="sheet-bg" {...backdrop(onClose)}>
      <div className="sheet center" role="dialog" aria-modal="true">
        <h3>Repartidor</h3>
        <input
          autoFocus
          placeholder="Nombre del repartidor"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="button"
          className="btn primary"
          disabled={!name.trim()}
          onClick={() => onPick(name.trim())}
        >
          Sale a reparto
        </button>
      </div>
    </div>
  );
}

function NewExternal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [f, setF] = useState({ kind: "llevar", name: "", phone: "", address: "", fee: "" });
  const [err, setErr] = useState<string | null>(null);
  const fee = Math.round((parseFloat(f.fee.replace(",", ".")) || 0) * 100);
  return (
    <div className="sheet-bg" {...backdrop(onClose)}>
      <div className="sheet center" role="dialog" aria-modal="true">
        <h3>Nuevo pedido</h3>
        <div className="row">
          {["llevar", "delivery"].map((k) => (
            <button
              type="button"
              key={k}
              className={`opt grow ${f.kind === k ? "on" : ""}`}
              onClick={() => setF({ ...f, kind: k })}
            >
              {k === "llevar" ? "Para llevar" : "Delivery"}
            </button>
          ))}
        </div>
        <input
          placeholder="Nombre"
          value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value })}
        />
        <input
          placeholder="Teléfono"
          inputMode="tel"
          value={f.phone}
          onChange={(e) => setF({ ...f, phone: e.target.value })}
        />
        {f.kind === "delivery" && (
          <>
            <input
              placeholder="Dirección"
              value={f.address}
              onChange={(e) => setF({ ...f, address: e.target.value })}
            />
            <input
              placeholder="Costo de envío"
              inputMode="decimal"
              value={f.fee}
              onChange={(e) => setF({ ...f, fee: e.target.value })}
            />
          </>
        )}
        {err && <p className="err">{err}</p>}
        <button
          type="button"
          className="btn primary"
          disabled={!f.name || (f.kind === "delivery" && !f.address)}
          onClick={() =>
            api<{ id: string }>("/api/orders/external", {
              body: {
                kind: f.kind,
                contact_name: f.name,
                phone: f.phone || undefined,
                address: f.address || undefined,
                fee_cents: f.kind === "delivery" ? fee : 0,
              },
            }).then(
              (r) => onCreated(r.id),
              (e) => setErr((e as Error).message),
            )
          }
        >
          Crear y tomar pedido
        </button>
      </div>
    </div>
  );
}
