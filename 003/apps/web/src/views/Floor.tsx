import { MergeSheet } from "./Order";
import { useEffect, useState } from "react";
import {
  OFFLINE_PREFIX,
  api,
  can,
  getUser,
  money,
  openTable as openTableApi,
  pendingOpens,
  useLive,
  useOfflineTick,
} from "../api";
import { PagedGrid, PagedRows } from "../fit";
import { NumPad } from "../numpad";
import { PaySheet } from "./Cash";

interface FloorAccount {
  id: string;
  status: string;
  opened_at: number;
  waiter: string;
  waiter_id: string;
  guests: number;
  total_cents: number;
  paid_cents: number;
  last_order_at: number | null;
}
interface FloorTable {
  id: string;
  number: string;
  zone_id: string | null;
  status: string;
  capacity: number;
  vip: number;
  linked_to: string | null;
  joined: string[];
  accounts: FloorAccount[];
  /** Abierta sin conexión: todavía no existe en el servidor. */
  unsynced?: boolean;
}

const LABEL: Record<string, string> = {
  disponible: "Disponible",
  ocupada: "Ocupada",
  reservada: "Reservada",
  esperando_pago: "Esperando pago",
  pagada: "Pagada",
  bloqueada: "Bloqueada",
  fuera_de_servicio: "Fuera de servicio",
};

const minutes = (ts: number) => Math.max(0, Math.floor((Date.now() - ts) / 60000));
const ago = (ts: number) => {
  const m = minutes(ts);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};

/**
 * Mapa de mesas: pestañas por área arriba, mesas al centro y un panel de detalle a la derecha con la mesa elegida
 * (mesero, comensales, tiempo, última comanda, consumo promedio) y sus acciones.
 */
export function Floor({ onOpen }: { onOpen: (accountId: string) => void }) {
  const { data: serverTables, error } = useLive(
    () => api<FloorTable[]>("/api/floor"),
    ["table.updated", "order.created", "order.updated"],
    [],
    "floor",
  );
  // Mesas abiertas sin conexión: se ven ocupadas de inmediato aunque el servidor aún no lo sepa
  useOfflineTick();
  const opens = pendingOpens();
  const tables = serverTables?.map((t): FloorTable => {
    const sh = opens.find((o) => o.tableId === t.id);
    return sh && t.status === "disponible"
      ? {
          ...t,
          status: "ocupada",
          unsynced: true,
          accounts: [
            {
              id: `${OFFLINE_PREFIX}${sh.ref}`,
              status: "abierta",
              opened_at: sh.openedAt,
              waiter: sh.waiter,
              waiter_id: sh.waiterId,
              guests: sh.guests,
              total_cents: 0,
              paid_cents: 0,
              last_order_at: null,
            },
          ],
        }
      : t;
  });
  const zones = useLive(() => api<{ id: string; name: string }[]>("/api/zones"), []);
  const ready = useLive(
    () =>
      api<
        { id: string; table_number: string; station: string; waiter: string; waiter_id: string }[]
      >("/api/ready"),
    ["ticket.updated", "order.created"],
  );
  const [zone, setZone] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [guests, setGuests] = useState("2");
  const [pay, setPay] = useState<{ id: string; table: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [join, setJoin] = useState<string | null>(null);
  const [, tick] = useState(0);
  const me = getUser();

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const visible = (tables ?? []).filter((t) => !zone || t.zone_id === zone);
  const free = (tables ?? []).filter((t) => t.status === "disponible").length;
  const current = (tables ?? []).find((t) => t.id === sel) ?? null;

  const select = (t: FloorTable) => {
    setErr(null);
    const mine = !t.linked_to && t.accounts.length === 1 && t.accounts[0]!.waiter_id === me?.id; // una mesa unida abre su panel (para poder separarla)
    if (mine) return onOpen(t.accounts[0]!.id); // la tuya: a pedir directo
    setSel(t.id);
    setGuests(String(Math.min(t.capacity, 2)));
  };

  const openTable = async (t: FloorTable) => {
    try {
      // Sin red la mesa se abre «en sombra» y se sincroniza al reconectar
      const r = await openTableApi(t, Math.max(1, Number(guests) || 1));
      onOpen(r.id);
    } catch (e) {
      setErr((e as Error).message); // p. ej. otra tablet abrió la mesa primero
    }
  };

  return (
    <div className="view">
      <div className="row">
        <div className="chips grow">
          <button className={`chip ${zone === null ? "on" : ""}`} onClick={() => setZone(null)}>
            Todas
          </button>
          {zones.data?.map((z) => (
            <button
              key={z.id}
              className={`chip ${zone === z.id ? "on" : ""}`}
              onClick={() => setZone(z.id)}
            >
              {z.name}
            </button>
          ))}
        </div>
        <span className="small">{free} libres</span>
      </div>
      {(error || err) && (
        <p className="err" style={{ flex: "none" }}>
          {err ?? error}
        </p>
      )}
      <div className="split">
        <PagedGrid
          items={visible}
          minW={150}
          minH={112}
          empty={<p className="muted">No hay mesas en esta área</p>}
          render={(t) => {
            const a = t.accounts[0];
            const total = t.accounts.reduce((s, x) => s + x.total_cents - x.paid_cents, 0);
            return (
              <button
                className={`table-card ${t.status} ${sel === t.id ? "selected" : ""}`}
                onClick={() => select(t)}
              >
                <div className="row spread">
                  <span className="n">{t.number}</span>
                  <span className="row" style={{ gap: 4 }}>
                    {t.vip ? <span className="tag">VIP</span> : null}
                    {t.status === "esperando_pago" && <span className="tag ember">Cuenta</span>}
                  </span>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="small ellipsis">
                    {t.linked_to ? `Unida a ${t.linked_to}` : (LABEL[t.status] ?? t.status)}
                    {t.unsynced ? " · sin sincronizar" : ""}
                    {a ? ` · ${ago(a.opened_at)}` : ` · ${t.capacity} pers.`}
                  </div>
                  {t.joined.length > 0 && (
                    <div className="small ellipsis">+ {t.joined.join(", ")}</div>
                  )}
                  {a && (
                    <div className="small ellipsis">
                      {a.waiter}
                      {a.waiter_id === me?.id ? " (tú)" : ""} · {a.guests} pers.
                    </div>
                  )}
                  {a && (
                    <div className="small ellipsis">
                      {a.last_order_at ? `última comanda ${ago(a.last_order_at)}` : "sin comandas"}
                    </div>
                  )}
                  {total > 0 && !t.linked_to && (
                    <div className="num ellipsis" style={{ fontWeight: 600 }}>
                      {money(total)}
                    </div>
                  )}
                </div>
              </button>
            );
          }}
        />

        <aside className="pane card" style={{ width: 290, flex: "none", padding: 12 }}>
          {current ? (
            <TableDetail
              table={current}
              guests={guests}
              setGuests={setGuests}
              onOpen={onOpen}
              onOpenTable={() => openTable(current)}
              onPay={(a) => setPay({ id: a.id, table: current.number })}
              onJoin={(id) => setJoin(id)}
              onClose={() => setSel(null)}
              reload={() => tables}
            />
          ) : (
            <>
              <h3>Listos para entregar</h3>
              <PagedRows
                items={ready.data ?? []}
                rowH={64}
                fixed
                empty={<p className="muted small">Nada pendiente de entregar</p>}
                row={(r) => (
                  <td style={{ padding: 0 }}>
                    <div className="row spread" style={{ height: 64, gap: 8, minWidth: 0 }}>
                      <div className="ellipsis" style={{ minWidth: 0, flex: "1 1 0" }}>
                        <strong>{r.table_number}</strong>
                        <div className="small ellipsis">
                          {r.station}
                          {r.waiter_id === me?.id ? " · tuyo" : ` · ${r.waiter}`}
                        </div>
                      </div>
                      {can("item.mark_delivered") && (
                        <button
                          className="btn primary"
                          style={{ minHeight: 44, flex: "none", padding: "0 12px" }}
                          onClick={() =>
                            api(`/api/tickets/${r.id}/status`, {
                              body: { status: "entregado" },
                            }).then(
                              () => ready.reload(),
                              (e) => setErr((e as Error).message),
                            )
                          }
                        >
                          Entregar
                        </button>
                      )}
                    </div>
                  </td>
                )}
              />
            </>
          )}
        </aside>
      </div>
      {join && <MergeSheet account={{ id: join }} onClose={() => setJoin(null)} />}
      {pay && (
        <PaySheet
          id={pay.id}
          table={pay.table}
          onClose={() => {
            setPay(null);
          }}
        />
      )}
    </div>
  );
}

function TableDetail({
  table,
  guests,
  setGuests,
  onOpen,
  onOpenTable,
  onPay,
  onJoin,
  onClose,
}: {
  table: FloorTable;
  guests: string;
  setGuests: (g: string) => void;
  onOpen: (id: string) => void;
  onOpenTable: () => void;
  onPay: (a: FloorAccount) => void;
  onJoin: (accountId: string) => void;
  onClose: () => void;
  reload: () => unknown;
}) {
  const a = table.accounts[0];
  const free = table.status === "disponible" || table.status === "reservada";
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <div className="row spread">
        <div>
          <h3>Mesa {table.number}</h3>
          <div className="small">
            {LABEL[table.status]} · capacidad {table.capacity}
          </div>
        </div>
        <button className="btn ghost sm" onClick={onClose}>
          ✕
        </button>
      </div>
      {free ? (
        <>
          <div className="small">¿Cuántas personas?</div>
          <div
            className="num"
            style={{ fontSize: 40, fontWeight: 600, textAlign: "center", lineHeight: 1 }}
          >
            {guests || "—"}
          </div>
          <NumPad value={guests} onChange={setGuests} max={2} />
          <button
            className="btn primary"
            disabled={!guests || Number(guests) < 1}
            onClick={onOpenTable}
          >
            Abrir mesa
          </button>
        </>
      ) : (
        <>
          {table.linked_to && (
            <div className="row spread">
              <span className="small">Unida a la mesa {table.linked_to}</span>
              {can("bill.merge") && (
                <button
                  className="btn sm"
                  onClick={() =>
                    api(`/api/tables/${table.id}/unjoin`, { body: {} }).catch((e) =>
                      setErr((e as Error).message),
                    )
                  }
                >
                  Separar
                </button>
              )}
            </div>
          )}
          {table.joined.length > 0 && (
            <div className="small">Mesas unidas: {table.joined.join(", ")}</div>
          )}
          {table.accounts.map((acc, i) => (
            <div
              key={acc.id}
              className="col"
              style={{
                gap: 4,
                borderTop: i ? "1px solid var(--color-fog)" : undefined,
                paddingTop: i ? 8 : 0,
              }}
            >
              <div className="row spread">
                <strong>{table.accounts.length > 1 ? `Cuenta ${i + 1}` : "Cuenta"}</strong>
                <span className="num" style={{ fontWeight: 600 }}>
                  {money(acc.total_cents - acc.paid_cents)}
                </span>
              </div>
              <div className="small">
                Mesero: {acc.waiter} · {acc.guests} personas
              </div>
              <div className="small">
                Abierta hace {ago(acc.opened_at)} ·{" "}
                {acc.last_order_at
                  ? `última comanda hace ${ago(acc.last_order_at)}`
                  : "sin comandas"}
              </div>
              {acc.guests > 0 && acc.total_cents > 0 && (
                <div className="small">
                  Consumo promedio: {money(Math.round(acc.total_cents / acc.guests))} por persona
                </div>
              )}
              {acc.paid_cents > 0 && (
                <div className="small">Ya pagado: {money(acc.paid_cents)}</div>
              )}
              <div className="row">
                <button
                  className="btn primary grow"
                  style={{ minHeight: 48 }}
                  onClick={() => onOpen(acc.id)}
                >
                  Abrir cuenta
                </button>
                {can("payment.take") && (
                  <button className="btn grow" onClick={() => onPay(acc)}>
                    Cobrar
                  </button>
                )}
              </div>
              {a === acc && !table.linked_to && can("bill.merge") && acc.status === "abierta" && (
                <button className="btn" onClick={() => onJoin(acc.id)}>
                  Juntar mesas
                </button>
              )}
              {a === acc && can("order.create") && acc.status === "abierta" && (
                <button
                  className="btn"
                  onClick={() =>
                    api(`/api/accounts/${acc.id}/request-bill`, { method: "POST", body: {} }).catch(
                      (e) => setErr((e as Error).message),
                    )
                  }
                >
                  Imprimir cuenta
                </button>
              )}
            </div>
          ))}
          {err && <p className="err">{err}</p>}
        </>
      )}
    </>
  );
}
