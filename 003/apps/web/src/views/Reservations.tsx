import { useState } from "react";
import { api, useLive } from "../api";
import { PagedRows, SubTabs } from "../fit";

interface Reservation { id: string; name: string; phone: string | null; party_size: number; at: number; table_number: string | null; table_id: string | null; status: string; notes: string | null; }
interface Customer { id: string; name: string; phone: string | null; rfc: string | null; }

const LABEL: Record<string, string> = { pendiente: "Pendiente", confirmada: "Confirmada", llego: "Llegó", cancelada: "Cancelada", no_se_presento: "No se presentó" };
const time = (ts: number) => new Date(ts).toLocaleString("es-MX", { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const local = (ts: number) => { const d = new Date(ts - new Date().getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };

export function Reservations({ onSeat }: { onSeat: (accountId: string) => void }) {
  const [tab, setTab] = useState<"reservas" | "clientes">("reservas");
  return (
    <div className="view">
      <SubTabs value={tab} onChange={setTab} tabs={[{ id: "reservas", label: "Reservaciones" }, { id: "clientes", label: "Clientes" }]} />
      {tab === "reservas" ? <Bookings onSeat={onSeat} /> : <Customers />}
    </div>
  );
}

function Bookings({ onSeat }: { onSeat: (accountId: string) => void }) {
  const list = useLive(() => api<Reservation[]>("/api/reservations"), ["reservation.updated"]);
  const tables = useLive(() => api<{ id: string; number: string }[]>("/api/tables"), []);
  const [f, setF] = useState({ name: "", phone: "", size: "2", at: local(Date.now() + 3600_000), table: "" });
  const [err, setErr] = useState<string | null>(null);
  const run = (p: Promise<unknown>) => p.then(() => { setErr(null); list.reload(); }, (e) => setErr((e as Error).message));

  return (
    <div className="split">
      <section className="card fillcard">
        {err && <p className="err">{err}</p>}
        <PagedRows items={list.data ?? []} rowH={56} empty={<p className="muted">Sin reservaciones en los próximos 7 días</p>}
          fixed head={<tr><th style={{ width: 92 }}>Hora</th><th>Nombre</th><th className="r" style={{ width: 54 }}>Pers.</th><th style={{ width: 58 }}>Mesa</th><th style={{ width: 196 }} /></tr>}
          row={(r) => (
            <>
              <td className="num ellipsis">{time(r.at)}</td>
              <td className="ellipsis"><div className="ellipsis" style={{ fontWeight: 600 }}>{r.name}</div><div className="small ellipsis">{LABEL[r.status]}{r.phone ? " · " + r.phone : ""}</div></td>
              <td className="r num">{r.party_size}</td><td>{r.table_number ?? "—"}</td>
              <td className="r"><div className="row" style={{ justifyContent: "flex-end", gap: 6, flexWrap: "nowrap" }}>
                {["pendiente", "confirmada"].includes(r.status) && <>
                  <button className="btn primary sm" style={{ minHeight: 40 }} onClick={() => api<{ accountId: string }>(`/api/reservations/${r.id}/seat`, { body: {} }).then((x) => onSeat(x.accountId), (e) => setErr((e as Error).message))}>Sentar</button>
                  <select aria-label="Más acciones" value="" style={{ minHeight: 40, width: 86, padding: "0 28px 0 10px" }} onChange={(e) => { const v = e.target.value; if (v) run(api(`/api/reservations/${r.id}/status`, { body: { status: v } })); }}>
                    <option value="">Más…</option>
                    {r.status === "pendiente" && <option value="confirmada">Confirmar</option>}
                    <option value="no_se_presento">No llegó</option>
                    <option value="cancelada">Cancelar</option>
                  </select></>}
              </div></td>
            </>
          )} />
      </section>
      <section className="card col" style={{ width: 340, flex: "none" }}>
        <h3>Nueva reservación</h3>
        <input placeholder="Nombre" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input placeholder="Teléfono" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        <div className="row"><input type="number" min={1} style={{ width: 80 }} value={f.size} onChange={(e) => setF({ ...f, size: e.target.value })} />
          <select className="grow" value={f.table} onChange={(e) => setF({ ...f, table: e.target.value })}><option value="">Mesa…</option>{tables.data?.map((t) => <option key={t.id} value={t.id}>Mesa {t.number}</option>)}</select></div>
        <input type="datetime-local" value={f.at} onChange={(e) => setF({ ...f, at: e.target.value })} />
        <button className="btn primary" disabled={!f.name || !f.at}
          onClick={() => run(api("/api/reservations", { body: { name: f.name, phone: f.phone || undefined, party_size: Number(f.size), at: new Date(f.at).getTime(), table_id: f.table || null } }).then(() => setF({ ...f, name: "", phone: "" })))}>Reservar</button>
      </section>
    </div>
  );
}

function Customers() {
  const [q, setQ] = useState("");
  const list = useLive(() => api<Customer[]>(`/api/customers${q ? `?q=${encodeURIComponent(q)}` : ""}`), [], [q]);
  const [f, setF] = useState({ name: "", phone: "", rfc: "" });
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="split">
      <section className="card fillcard">
        <input placeholder="Buscar nombre o teléfono" value={q} onChange={(e) => setQ(e.target.value)} />
        <PagedRows items={list.data ?? []} rowH={48} empty={<p className="muted">Sin clientes</p>} head={<tr><th>Nombre</th><th>Teléfono</th><th>RFC</th></tr>}
          row={(c) => <><td>{c.name}</td><td className="small">{c.phone}</td><td className="small">{c.rfc}</td></>} />
      </section>
      <section className="card col" style={{ width: 340, flex: "none" }}>
        <h3>Nuevo cliente</h3>
        <input placeholder="Nombre" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input placeholder="Teléfono" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        <input placeholder="RFC" value={f.rfc} onChange={(e) => setF({ ...f, rfc: e.target.value })} />
        {err && <p className="err">{err}</p>}
        <button className="btn primary" disabled={!f.name} onClick={() => api("/api/customers", { body: { name: f.name, phone: f.phone || null, rfc: f.rfc || null } }).then(() => { setF({ name: "", phone: "", rfc: "" }); list.reload(); }, (e) => setErr((e as Error).message))}>Agregar cliente</button>
      </section>
    </div>
  );
}
