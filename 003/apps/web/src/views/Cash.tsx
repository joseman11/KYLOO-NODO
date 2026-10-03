import { Hint, StatusChip } from "../ui";
import { useState } from "react";
import { backdrop } from "../sheet";
import { ApiError, api, can, money, useLive } from "../api";
import { PagedGrid } from "../fit";
import { NumPad } from "../numpad";
import { FiscalSheet } from "./Invoices";

interface FloorTable {
  number: string;
  accounts: {
    id: string;
    status: string;
    total_cents: number;
    paid_cents: number;
    waiter: string;
  }[];
}
interface Summary {
  opening_cents: number;
  sales_cents: number;
  by_method: Record<string, number>;
  tips_cents: number;
  withdrawals_cents: number;
  incomes_cents: number;
  expected_cash_cents: number;
  cancelled_items: number;
}
interface Current {
  session: { id: string; opened_at: number };
  summary: Summary;
}
interface External {
  id: string;
  label: string;
  contact_name: string;
  total_cents: number;
  account_status: string;
}
interface Balance {
  total_cents: number;
  paid_cents: number;
  balance_cents: number;
  guests: number;
  payments: number;
  seats: { seat: number | null; subtotal_cents: number; share_cents: number; paid: boolean }[];
}

const METHODS = ["efectivo", "tarjeta", "transferencia", "qr", "regalo", "otro"] as const;
const METHOD_LABEL: Record<string, string> = {
  efectivo: "Efectivo",
  tarjeta: "Tarjeta",
  transferencia: "Transferencia",
  qr: "QR",
  regalo: "Tarjeta de regalo",
  otro: "Otro",
};
const toCents = (v: string) => Math.round(parseFloat(v.replace(",", ".")) * 100) || 0;

export function Cash() {
  const cash = useLive(
    () =>
      api<Current>("/api/cash/current").catch((e) =>
        e instanceof ApiError && e.status === 404 ? null : Promise.reject(e),
      ),
    ["payment.created"],
  );
  const floor = useLive(
    () => api<FloorTable[]>("/api/floor"),
    ["table.updated", "payment.created"],
  );
  const external = useLive(
    () => api<External[]>("/api/delivery"),
    ["delivery.updated", "payment.created", "order.created"],
  );
  // Si la impresora de caja tiene cajón de dinero, se puede abrir a mano (dar cambio, retirar efectivo)
  const printers = useLive(
    () => api<{ id: string; kind: string; has_drawer: number }[]>("/api/printers"),
    [],
  );
  const drawer = printers.data?.find((p) => p.kind === "caja" && p.has_drawer);
  const [drawerMsg, setDrawerMsg] = useState<string | null>(null);
  const drawerButton = drawer && (
    <button
      type="button"
      className="btn"
      onClick={() =>
        api<{ ok: boolean; error?: string }>(`/api/printers/${drawer.id}/open-drawer`, {
          method: "POST",
          body: {},
        }).then(
          (r) => setDrawerMsg(r.ok ? null : "El cajón no respondió; se reintentará solo"),
          (e) => setDrawerMsg((e as Error).message),
        )
      }
    >
      Abrir cajón
    </button>
  );
  const [paying, setPaying] = useState<{ id: string; table: string } | null>(null);
  const [opening, setOpening] = useState("2000");
  const [err, setErr] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [gift, setGift] = useState(false);

  if (cash.data === null || (cash.data === undefined && !cash.error)) {
    return (
      <div className="card col" style={{ maxWidth: 420 }}>
        <h2>Abrir caja</h2>
        <label className="small">Fondo inicial (efectivo)</label>
        <input inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} />
        {err && <p className="err">{err}</p>}
        {drawerButton}
        <button
          type="button"
          className="btn primary"
          disabled={!can("cash.open") || cash.data === undefined}
          onClick={() =>
            api("/api/cash/open", { body: { opening_cents: toCents(opening) } }).then(
              () => cash.reload(),
              (e) => setErr((e as Error).message),
            )
          }
        >
          Abrir caja
        </button>
      </div>
    );
  }

  const accounts = [
    ...(floor.data ?? []).flatMap((t) => t.accounts.map((a) => ({ ...a, table: t.number }))),
    ...(external.data ?? [])
      .filter((e) => e.account_status !== "cerrada")
      .map((e) => ({
        id: e.id,
        status: e.account_status,
        total_cents: e.total_cents,
        paid_cents: 0,
        waiter: e.contact_name,
        table: e.label,
      })),
  ].sort((a, b) => Number(b.status === "pago_solicitado") - Number(a.status === "pago_solicitado"));
  const s = cash.data?.summary;

  return (
    <div className="view">
      <div className="row spread" style={{ flex: "none" }}>
        <Hint id="caja">
          Toca una cuenta para cobrarla. Las que pidieron la cuenta van primero.
        </Hint>
        <div className="row">
          {drawerButton}
          <button type="button" className="btn" onClick={() => setGift(true)}>
            Tarjeta de regalo
          </button>
          <button type="button" className="btn" onClick={() => setClosing(true)}>
            Corte / Movimientos
          </button>
        </div>
      </div>
      {drawerMsg && (
        <p className="err" style={{ flex: "none" }}>
          {drawerMsg}
        </p>
      )}
      {s && (
        <div className="stats">
          <div className="card stat">
            <div className="small">Ventas</div>
            <div className="v num">{money(s.sales_cents)}</div>
          </div>
          <div className="card stat">
            <div className="small">Efectivo esperado</div>
            <div className="v num">{money(s.expected_cash_cents)}</div>
          </div>
          <div className="card stat">
            <div className="small">Propinas</div>
            <div className="v num">{money(s.tips_cents)}</div>
          </div>
        </div>
      )}
      <h3 style={{ flex: "none" }}>Cuentas abiertas · {accounts.length}</h3>
      <PagedGrid
        items={accounts}
        minW={170}
        minH={96}
        empty={<p className="muted">No hay cuentas abiertas</p>}
        render={(a) => (
          <button
            type="button"
            className={`table-card ${a.status === "pago_solicitado" ? "esperando_pago" : "ocupada"}`}
            disabled={!can("payment.take")}
            onClick={() => setPaying({ id: a.id, table: a.table })}
          >
            <div className="row spread" style={{ alignItems: "flex-start" }}>
              <span className="n">{a.table}</span>
              {a.status === "pago_solicitado" ? (
                <StatusChip tone="warn" icon="cuenta">
                  Pide cuenta
                </StatusChip>
              ) : (
                <StatusChip tone="info" icon="ocupada">
                  Abierta
                </StatusChip>
              )}
            </div>
            <div>
              <div className="small ellipsis">{a.waiter}</div>
              <div className="num total">
                {money(a.total_cents - a.paid_cents)}
                {a.paid_cents > 0 && <span className="small"> pendiente</span>}
              </div>
            </div>
          </button>
        )}
      />
      {paying && (
        <PaySheet
          {...paying}
          onClose={() => {
            setPaying(null);
            cash.reload();
            floor.reload();
            external.reload();
          }}
        />
      )}
      {closing && s && (
        <CutSheet
          summary={s}
          onClose={() => {
            setClosing(false);
            cash.reload();
          }}
        />
      )}
      {gift && (
        <GiftSheet
          onClose={() => {
            setGift(false);
            cash.reload();
          }}
        />
      )}
    </div>
  );
}

type Mode = "total" | "partes" | "asiento";
interface Line {
  method: string;
  amount: string;
  reference: string;
}

/**
 * Cobro de una cuenta: completa, en partes iguales o por asiento. Cada pago cubre una parte y la cuenta
 * se cierra al saldarse. Acepta pago mixto, propina y tarjetas de regalo.
 */
export function PaySheet({
  id,
  table,
  onClose,
}: {
  id: string;
  table: string;
  onClose: () => void;
}) {
  const bal = useLive(() => api<Balance>(`/api/accounts/${id}/balance`), []);
  const [mode, setMode] = useState<Mode>("total");
  const [people, setPeople] = useState<string | null>(null);
  const [seat, setSeat] = useState<number | null>(null);
  const [lines, setLines] = useState<Line[]>([{ method: "efectivo", amount: "", reference: "" }]);
  const [tip, setTip] = useState("0");
  const [tipMethod, setTipMethod] = useState("efectivo");
  const [key, setKey] = useState(() => crypto.randomUUID()); // misma clave en reintentos: nunca cobra dos veces
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ change: number; closed: boolean; balance: number } | null>(
    null,
  );
  const [invoicing, setInvoicing] = useState(false);

  const b = bal.data;
  if (!b)
    return (
      <div className="sheet-bg">
        <div className="sheet center">
          <p className="muted">Cargando…</p>
        </div>
      </div>
    );

  // Cuánto cubre este pago según el modo
  const unpaidSeats = b.seats.filter((s) => s.seat !== null && !s.paid);
  const remainingParts = Math.max(1, Number(people ?? Math.max(1, b.guests - b.payments)) || 1);
  const equalShare =
    remainingParts <= 1 ? b.balance_cents : Math.round(b.balance_cents / remainingParts);
  const chosenSeat = unpaidSeats.find((s) => s.seat === seat) ?? null;
  const isLastSeat = unpaidSeats.length === 1 && chosenSeat !== null;
  const cover =
    mode === "total"
      ? b.balance_cents
      : mode === "partes"
        ? Math.min(b.balance_cents, equalShare)
        : chosenSeat
          ? isLastSeat
            ? b.balance_cents
            : Math.min(b.balance_cents, chosenSeat.share_cents)
          : 0;

  const paid = lines.reduce((s, l) => s + toCents(l.amount), 0);
  const missing = cover - paid;
  const set = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const fillExact = (i: number) =>
    set(i, {
      amount: (
        Math.max(0, cover - lines.reduce((s, l, j) => (j === i ? s : s + toCents(l.amount)), 0)) /
        100
      ).toFixed(2),
    });

  const reset = () => {
    setLines([{ method: "efectivo", amount: "", reference: "" }]);
    setTip("0");
    setKey(crypto.randomUUID());
    setErr(null);
    setSeat(null);
  };

  const submit = async () => {
    try {
      const r = await api<{ change_cents: number; closed: boolean; balance_cents: number }>(
        `/api/accounts/${id}/payments`,
        {
          body: {
            idempotencyKey: key,
            cover_cents: cover,
            seat: mode === "asiento" && chosenSeat?.seat ? chosenSeat.seat : undefined,
            lines: lines
              .filter((l) => toCents(l.amount) > 0)
              .map((l) => ({
                method: l.method,
                amount_cents: toCents(l.amount),
                reference: l.reference || undefined,
              })),
            tip_cents: toCents(tip),
            tip_method: tipMethod,
          },
        },
      );
      setDone({ change: r.change_cents, closed: r.closed, balance: r.balance_cents });
    } catch (e) {
      setErr(
        e instanceof ApiError && e.code === "saldo_insuficiente"
          ? "La tarjeta de regalo no tiene saldo suficiente"
          : e instanceof ApiError && e.code === "tarjeta_no_encontrada"
            ? "No existe una tarjeta con ese código"
            : (e as Error).message,
      );
    }
  };

  if (done) {
    return (
      <div className="sheet-bg">
        <div className="sheet center">
          <h2>{done.closed ? "Cobrado" : "Pago registrado"}</h2>
          {done.change > 0 && (
            <p>
              <span className="small">Cambio</span>
              <br />
              <strong className="num" style={{ fontSize: 36 }}>
                {money(done.change)}
              </strong>
            </p>
          )}
          {!done.closed && (
            <p>
              Saldo pendiente: <strong className="num">{money(done.balance)}</strong>
            </p>
          )}
          <div className="row">
            {done.closed && can("invoice.manage") && (
              <button type="button" className="btn grow" onClick={() => setInvoicing(true)}>
                Facturar
              </button>
            )}
            {!done.closed && (
              <button
                type="button"
                className="btn primary grow"
                onClick={() => {
                  setDone(null);
                  reset();
                  bal.reload();
                  setPeople(null);
                }}
              >
                Cobrar siguiente parte
              </button>
            )}
            <button
              type="button"
              className={`btn grow ${done.closed ? "primary" : ""}`}
              onClick={onClose}
            >
              {done.closed ? "Listo" : "Cerrar"}
            </button>
          </div>
          {invoicing && <FiscalSheet accountId={id} onClose={() => setInvoicing(false)} />}
        </div>
      </div>
    );
  }

  return (
    <div className="sheet-bg" {...backdrop(onClose)}>
      <div className="sheet center" style={{ width: "min(600px, 100%)" }}>
        <div className="row spread">
          <h2>{table}</h2>
          <div className="small" style={{ textAlign: "right" }}>
            Total {money(b.total_cents)}
            {b.paid_cents > 0 && <> · pagado {money(b.paid_cents)}</>}
          </div>
        </div>
        <div className="row">
          {(
            [
              ["total", "Cuenta completa"],
              ["partes", "Partes iguales"],
              ["asiento", "Por asiento"],
            ] as const
          ).map(([k, l]) => (
            <button
              type="button"
              key={k}
              className={`opt grow ${mode === k ? "on" : ""}`}
              disabled={k === "asiento" && unpaidSeats.length === 0}
              onClick={() => {
                setMode(k);
                setErr(null);
              }}
            >
              {l}
            </button>
          ))}
        </div>

        {mode === "partes" && (
          <div className="row">
            <span className="small grow">¿Entre cuántas personas falta dividir?</span>
            <div className="stepper">
              <button
                type="button"
                className="btn"
                onClick={() => setPeople(String(Math.max(1, remainingParts - 1)))}
              >
                −
              </button>
              <span className="num" style={{ minWidth: 32, textAlign: "center", fontWeight: 600 }}>
                {remainingParts}
              </span>
              <button
                type="button"
                className="btn"
                onClick={() => setPeople(String(remainingParts + 1))}
              >
                +
              </button>
            </div>
          </div>
        )}
        {mode === "asiento" && (
          <div className="row wrap">
            {b.seats
              .filter((s) => s.seat !== null)
              .map((s) => (
                <button
                  type="button"
                  key={s.seat}
                  className={`opt ${seat === s.seat ? "on" : ""}`}
                  disabled={s.paid}
                  onClick={() => setSeat(s.seat)}
                >
                  Asiento {s.seat} · {s.paid ? "pagado" : money(s.share_cents)}
                </button>
              ))}
          </div>
        )}

        <div
          className="row spread"
          style={{
            alignItems: "baseline",
            background: "var(--color-fog)",
            borderRadius: 10,
            padding: "8px 12px",
          }}
        >
          <span>Este pago cubre</span>
          <strong className="num" style={{ fontSize: 28 }}>
            {money(cover)}
          </strong>
        </div>

        {lines.slice(0, 3).map((l, i) => (
          <div key={i} className="row">
            <select value={l.method} onChange={(e) => set(i, { method: e.target.value })}>
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {METHOD_LABEL[m]}
                </option>
              ))}
            </select>
            {l.method === "regalo" && (
              <input
                style={{ width: 150 }}
                placeholder="GC-XXXX-XXXX"
                autoCapitalize="characters"
                value={l.reference}
                onChange={(e) => set(i, { reference: e.target.value.toUpperCase() })}
              />
            )}
            <input
              className="grow num"
              inputMode="decimal"
              placeholder="Monto"
              value={l.amount}
              onChange={(e) => set(i, { amount: e.target.value })}
              onFocus={() => {
                if (!l.amount) fillExact(i);
              }}
            />
          </div>
        ))}
        <div className="row">
          <button
            type="button"
            className="btn"
            disabled={lines.length >= 3}
            onClick={() => setLines([...lines, { method: "tarjeta", amount: "", reference: "" }])}
          >
            + Otro método
          </button>
          <span className={`grow small num ${missing > 0 ? "err" : ""}`}>
            {missing > 0
              ? `Falta ${money(missing)}`
              : missing < 0
                ? `Cambio ${money(-missing)}`
                : cover > 0
                  ? "Exacto"
                  : ""}
          </span>
        </div>
        <div className="row">
          <span className="small">Propina</span>
          <input
            className="grow num"
            inputMode="decimal"
            value={tip}
            onChange={(e) => setTip(e.target.value)}
          />
          <select value={tipMethod} onChange={(e) => setTipMethod(e.target.value)}>
            {METHODS.filter((m) => m !== "regalo").map((m) => (
              <option key={m} value={m}>
                {METHOD_LABEL[m]}
              </option>
            ))}
          </select>
        </div>
        {err && <p className="err">{err}</p>}
        <button
          type="button"
          className="btn primary"
          disabled={cover <= 0 || missing > 0 || (mode === "asiento" && !chosenSeat)}
          onClick={submit}
        >
          Cobrar {money(cover)}
        </button>
      </div>
    </div>
  );
}

/** Venta de una tarjeta de regalo: monto, forma de pago y código para entregar. */
function GiftSheet({ onClose }: { onClose: () => void }) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("efectivo");
  const [sold, setSold] = useState<{ code: string; balance_cents: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const cents = Number(amount || 0) * 100;
  if (sold) {
    return (
      <div className="sheet-bg">
        <div className="sheet center">
          <h2>Tarjeta vendida</h2>
          <div
            className="num"
            style={{
              fontSize: 34,
              fontWeight: 700,
              letterSpacing: "0.02em",
              textAlign: "center",
              userSelect: "text",
            }}
          >
            {sold.code}
          </div>
          <p className="small" style={{ textAlign: "center" }}>
            Saldo {money(sold.balance_cents)}. El código también salió en la impresora de caja.
          </p>
          <button type="button" className="btn primary" onClick={onClose}>
            Listo
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="sheet-bg" {...backdrop(onClose)}>
      <div className="sheet center" style={{ width: "min(420px, 100%)" }}>
        <h3>Vender tarjeta de regalo</h3>
        <div className="num" style={{ fontSize: 34, fontWeight: 600, textAlign: "center" }}>
          {money(cents)}
        </div>
        <NumPad value={amount} onChange={setAmount} max={5} />
        <div className="row">
          {["efectivo", "tarjeta", "transferencia"].map((m) => (
            <button
              type="button"
              key={m}
              className={`opt grow ${method === m ? "on" : ""}`}
              onClick={() => setMethod(m)}
            >
              {METHOD_LABEL[m]}
            </button>
          ))}
        </div>
        {err && <p className="err">{err}</p>}
        <button
          type="button"
          className="btn primary"
          disabled={cents < 1000}
          onClick={() =>
            api<{ code: string; balance_cents: number }>("/api/gift-cards", {
              body: { amount_cents: cents, method },
            }).then(setSold, (e) => setErr((e as Error).message))
          }
        >
          Vender (mínimo $10)
        </button>
      </div>
    </div>
  );
}

/** Corte de caja en tres pestañas (resumen, movimiento, corte final) para que nada requiera desplazarse. */
function CutSheet({ summary: s, onClose }: { summary: Summary; onClose: () => void }) {
  const [tab, setTab] = useState<"resumen" | "mov" | "corte">("resumen");
  const [counted, setCounted] = useState("");
  const [reason, setReason] = useState("");
  const [move, setMove] = useState({ kind: "retiro", amount: "", reason: "", authId: "", pin: "" });
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<number | null>(null);
  const users = useLive(
    () => api<{ id: string; name: string; role: string }[]>("/api/auth/users"),
    [],
  );
  const diff = counted ? toCents(counted) - s.expected_cash_cents : 0;

  const close = () =>
    api<{ difference_cents: number }>("/api/cash/close", {
      body: { counted_cents: toCents(counted), reason: reason || undefined },
    }).then(
      (r) => setResult(r.difference_cents),
      (e) => setErr((e as Error).message),
    );
  const saveMove = () =>
    api("/api/cash/movements", {
      body: {
        kind: move.kind,
        amount_cents: toCents(move.amount),
        reason: move.reason,
        authorizerId: move.authId || undefined,
        authorizerPin: move.pin || undefined,
      },
    }).then(onClose, (e) =>
      setErr(
        e instanceof ApiError && e.code === "requiere_autorizacion"
          ? "Requiere autorización: elige gerente y PIN"
          : (e as Error).message,
      ),
    );

  if (result !== null) {
    return (
      <div className="sheet-bg">
        <div className="sheet center">
          <h2>Caja cerrada</h2>
          <p>
            Diferencia: <strong className="num">{money(result)}</strong>
          </p>
          <button type="button" className="btn primary" onClick={() => location.reload()}>
            Aceptar
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="sheet-bg" {...backdrop(onClose)}>
      <div className="sheet center" role="dialog" aria-modal="true">
        <div className="row spread">
          <h2>Caja</h2>
          <div className="row">
            {(
              [
                ["resumen", "Resumen"],
                ["mov", "Retiro / ingreso"],
                ["corte", "Corte final"],
              ] as const
            ).map(([id, l]) => (
              <button
                type="button"
                key={id}
                className={`chip ${tab === id ? "on" : ""}`}
                onClick={() => {
                  setTab(id);
                  setErr(null);
                }}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        {tab === "resumen" && (
          <table>
            <tbody>
              <tr style={{ height: 36 }}>
                <td>Fondo inicial</td>
                <td className="r num">{money(s.opening_cents)}</td>
              </tr>
              {Object.entries(s.by_method).map(([m, v]) => (
                <tr key={m} style={{ height: 36 }}>
                  <td>Ventas {METHOD_LABEL[m] ?? m}</td>
                  <td className="r num">{money(v)}</td>
                </tr>
              ))}
              <tr style={{ height: 36 }}>
                <td>Ingresos</td>
                <td className="r num">{money(s.incomes_cents)}</td>
              </tr>
              <tr style={{ height: 36 }}>
                <td>Retiros</td>
                <td className="r num">−{money(s.withdrawals_cents)}</td>
              </tr>
              <tr style={{ height: 40 }}>
                <td>
                  <strong>Efectivo esperado</strong>
                </td>
                <td className="r num">
                  <strong>{money(s.expected_cash_cents)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        )}

        {tab === "mov" && (
          <>
            <div className="row">
              <select
                value={move.kind}
                onChange={(e) => setMove({ ...move, kind: e.target.value })}
              >
                <option>retiro</option>
                <option>ingreso</option>
              </select>
              <input
                className="grow num"
                placeholder="Monto"
                inputMode="decimal"
                value={move.amount}
                onChange={(e) => setMove({ ...move, amount: e.target.value })}
              />
            </div>
            <input
              placeholder="Motivo"
              value={move.reason}
              onChange={(e) => setMove({ ...move, reason: e.target.value })}
            />
            {move.kind === "retiro" && !can("cash.withdraw") && (
              <div className="row">
                <select
                  className="grow"
                  value={move.authId}
                  onChange={(e) => setMove({ ...move, authId: e.target.value })}
                >
                  <option value="">Autoriza…</option>
                  {users.data
                    ?.filter((u) => ["gerente", "admin", "encargado_caja"].includes(u.role))
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                </select>
                <input
                  type="password"
                  inputMode="numeric"
                  placeholder="PIN"
                  style={{ width: 120 }}
                  value={move.pin}
                  onChange={(e) => setMove({ ...move, pin: e.target.value })}
                />
              </div>
            )}
            {err && <p className="err">{err}</p>}
            <button
              type="button"
              className="btn primary"
              disabled={!toCents(move.amount) || move.reason.length < 2}
              onClick={saveMove}
            >
              Registrar
            </button>
          </>
        )}

        {tab === "corte" && (
          <>
            <p className="small">
              Efectivo esperado: <strong className="num">{money(s.expected_cash_cents)}</strong>
            </p>
            <input
              className="num"
              placeholder="Efectivo contado"
              inputMode="decimal"
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
            />
            {counted && (
              <p className={`small num ${diff !== 0 ? "err" : ""}`}>Diferencia: {money(diff)}</p>
            )}
            {diff !== 0 && counted && (
              <input
                placeholder="Motivo de la diferencia"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
            {err && <p className="err">{err}</p>}
            <button
              type="button"
              className="btn primary"
              disabled={!counted || (diff !== 0 && !reason)}
              onClick={close}
            >
              Cerrar caja
            </button>
          </>
        )}
        <button type="button" className="btn ghost" onClick={onClose}>
          Cerrar ventana
        </button>
      </div>
    </div>
  );
}
