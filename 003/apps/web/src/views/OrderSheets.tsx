import { useState } from "react";
import { ApiError, api, money, useLive } from "../api";

export function DiscountSheet({ accountId, subtotalCents, onClose }: { accountId: string; subtotalCents: number; onClose: () => void }) {
  const promos = useLive(() => api<{ id: string; name: string; amount_cents: number }[]>(`/api/accounts/${accountId}/promotions`), []);
  const users = useLive(() => api<{ id: string; name: string; role: string }[]>("/api/auth/users"), []);
  const [pct, setPct] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("Cortesía");
  const [needAuth, setNeedAuth] = useState(false);
  const [authId, setAuthId] = useState("");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const cents = Math.round((parseFloat(amount.replace(",", ".")) || 0) * 100);

  const apply = async () => {
    try {
      await api(`/api/accounts/${accountId}/discounts`, {
        body: { kind: pct ? "porcentaje" : "monto", value: pct ?? cents, reason, authorizerId: authId || undefined, authorizerPin: pin || undefined },
      });
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === "requiere_autorizacion") {
        setNeedAuth(true);
        setErr(null);
      } else {
        setErr(e instanceof ApiError && e.code === "autorizacion_invalida" ? "Autorización inválida" : (e as Error).message);
      }
    }
  };

  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet center" onClick={(e) => e.stopPropagation()}>
        <h3>Descuento · subtotal {money(subtotalCents)}</h3>
        {promos.data && promos.data.length > 0 && (
          <div className="col">
            <div className="small">Promociones vigentes</div>
            {promos.data.slice(0, 3).map((p) => (
              <button key={p.id} className="opt" onClick={() => api(`/api/accounts/${accountId}/promotions/${p.id}/apply`, { body: {} }).then(onClose, (e) => setErr((e as Error).message))}>
                {p.name} · −{money(p.amount_cents)}
              </button>
            ))}
          </div>
        )}
        <div className="small">Descuento manual</div>
        <div className="row wrap">
          {[5, 10, 15, 20, 30].map((p) => (
            <button key={p} className={`opt ${pct === p ? "on" : ""}`} onClick={() => { setPct(pct === p ? null : p); setAmount(""); }}>{p}%</button>
          ))}
        </div>
        <input placeholder="o monto fijo ($)" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setPct(null); }} />
        <input placeholder="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} />
        {needAuth && (
          <div className="col">
            <p className="small">Supera el límite: requiere autorización de un gerente.</p>
            <select value={authId} onChange={(e) => setAuthId(e.target.value)}>
              <option value="">Gerente…</option>
              {users.data?.filter((u) => ["gerente", "admin"].includes(u.role)).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <input type="password" inputMode="numeric" placeholder="PIN del gerente" value={pin} onChange={(e) => setPin(e.target.value)} />
          </div>
        )}
        {err && <p className="err">{err}</p>}
        <button className="btn primary" disabled={(!pct && !cents) || reason.length < 2} onClick={apply}>Aplicar descuento</button>
      </div>
    </div>
  );
}

export function CustomerSheet({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const [q, setQ] = useState("");
  const list = useLive(() => api<{ id: string; name: string; phone: string | null }[]>(`/api/customers${q ? `?q=${encodeURIComponent(q)}` : ""}`), [], [q]);
  const [name, setName] = useState("");
  const assign = (customerId: string) => api(`/api/accounts/${accountId}/customer`, { body: { customerId } }).then(onClose);
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet center" onClick={(e) => e.stopPropagation()}>
        <h3>Cliente de la cuenta</h3>
        <input placeholder="Buscar por nombre o teléfono" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="col">
          {list.data?.slice(0, 6).map((c) => (
            <button key={c.id} className="opt" onClick={() => assign(c.id)}>{c.name} {c.phone && <span className="small">· {c.phone}</span>}</button>
          ))}
        </div>
        <div className="row">
          <input className="grow" placeholder="Nuevo cliente" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn" disabled={!name} onClick={() => api<{ id: string }>("/api/customers", { body: { name } }).then((r) => assign(r.id))}>Crear</button>
        </div>
      </div>
    </div>
  );
}
