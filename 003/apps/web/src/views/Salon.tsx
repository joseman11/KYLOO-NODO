import { useState } from "react";
import { backdrop } from "../sheet";
import { api, useLive } from "../api";
import { PagedGrid, PagedRows } from "../fit";
import { NumPad } from "../numpad";

interface Zone {
  id: string;
  name: string;
  prefix: string;
  sort: number;
}
interface Table {
  id: string;
  zone_id: string | null;
  number: string;
  capacity: number;
  vip: number;
  status: string;
}

const NONE = "__sin_area__";

/**
 * Salón: el usuario crea las áreas del restaurante (Salón, Terraza, Barra…) y las mesas de cada una.
 * Las mesas se crean con un teclado numérico y pueden generarse varias de golpe (T1…T6).
 */
export function Salon() {
  const zones = useLive(() => api<Zone[]>("/api/zones"), []);
  const tables = useLive(() => api<Table[]>("/api/tables"), []);
  const [sel, setSel] = useState<string | null>(null);
  const [zoneSheet, setZoneSheet] = useState<Zone | "new" | null>(null);
  const [tableSheet, setTableSheet] = useState<Table | "new" | null>(null);
  const [bulk, setBulk] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const zs = zones.data ?? [];
  const ts = tables.data ?? [];
  const orphans = ts.filter((t) => !t.zone_id || !zs.some((z) => z.id === t.zone_id));
  const current =
    sel === NONE
      ? NONE
      : (zs.find((z) => z.id === sel)?.id ?? zs[0]?.id ?? (orphans.length ? NONE : null));
  const zone = zs.find((z) => z.id === current) ?? null;
  const inArea = current === NONE ? orphans : ts.filter((t) => t.zone_id === current);
  const reload = () => {
    zones.reload();
    tables.reload();
  };

  return (
    <div className="split">
      <section className="card fillcard" style={{ width: 280, flex: "none" }}>
        <h3>Áreas</h3>
        <PagedRows
          items={[
            ...zs.map((z) => ({
              id: z.id,
              name: z.name,
              n: ts.filter((t) => t.zone_id === z.id).length,
            })),
            ...(orphans.length ? [{ id: NONE, name: "Sin área", n: orphans.length }] : []),
          ]}
          rowH={56}
          empty={<p className="muted small">Crea tu primera área: Salón, Terraza, Barra…</p>}
          row={(z) => (
            <td style={{ padding: 0 }}>
              <button
                type="button"
                className={`opt ${z.id === current ? "on" : ""}`}
                style={{
                  width: "100%",
                  height: 48,
                  textAlign: "left",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
                onClick={() => setSel(z.id)}
              >
                <span className="ellipsis">{z.name}</span>
                <span style={{ opacity: 0.7 }}>{z.n} mesas</span>
              </button>
            </td>
          )}
        />
        <button
          type="button"
          className="btn primary"
          style={{ flex: "none" }}
          onClick={() => setZoneSheet("new")}
        >
          + Nueva área
        </button>
      </section>

      <section className="card fillcard">
        <div className="row spread" style={{ flex: "none" }}>
          <div style={{ minWidth: 0 }}>
            <h3 className="ellipsis">
              {zone ? zone.name : current === NONE ? "Mesas sin área" : "Mesas"}
            </h3>
            {zone && (
              <div className="small">
                {zone.prefix
                  ? `Las mesas se nombran ${zone.prefix}1, ${zone.prefix}2…`
                  : "Sin prefijo: las mesas llevan solo su número"}
              </div>
            )}
          </div>
          <div className="row">
            {zone && (
              <button type="button" className="btn sm" onClick={() => setZoneSheet(zone)}>
                Editar área
              </button>
            )}
            <button type="button" className="btn sm" disabled={!zone} onClick={() => setBulk(true)}>
              + Varias mesas
            </button>
            <button
              type="button"
              className="btn primary"
              style={{ minHeight: 48 }}
              disabled={!zone && current !== NONE}
              onClick={() => setTableSheet("new")}
            >
              + Mesa
            </button>
          </div>
        </div>
        {err && <p className="err">{err}</p>}
        <PagedGrid
          items={inArea}
          minW={120}
          minH={84}
          gap={10}
          empty={
            <p className="muted">
              Esta área aún no tiene mesas. Usa "+ Varias mesas" para crearlas de golpe.
            </p>
          }
          render={(t) => (
            <button
              type="button"
              className={`table-card ${t.status === "fuera_de_servicio" ? "fuera_de_servicio" : ""}`}
              onClick={() => setTableSheet(t)}
            >
              <div className="row spread">
                <span className="n" style={{ fontSize: 26 }}>
                  {t.number}
                </span>
                {t.vip ? <span className="tag">VIP</span> : null}
              </div>
              <div className="small">
                {t.capacity} personas
                {t.status === "fuera_de_servicio" ? " · fuera de servicio" : ""}
              </div>
            </button>
          )}
        />
      </section>

      {zoneSheet && (
        <ZoneSheet
          zone={zoneSheet === "new" ? null : zoneSheet}
          onClose={(id) => {
            setZoneSheet(null);
            if (id) setSel(id);
            reload();
          }}
        />
      )}
      {tableSheet && (
        <TableSheet
          table={tableSheet === "new" ? null : tableSheet}
          zones={zs}
          defaultZone={zone?.id ?? null}
          onClose={() => {
            setTableSheet(null);
            reload();
          }}
          onError={setErr}
        />
      )}
      {bulk && zone && (
        <BulkSheet
          zone={zone}
          existing={ts.filter((t) => t.zone_id === zone.id).map((t) => t.number)}
          onClose={() => {
            setBulk(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function ZoneSheet({ zone, onClose }: { zone: Zone | null; onClose: (id?: string) => void }) {
  const [name, setName] = useState(zone?.name ?? "");
  const [prefix, setPrefix] = useState(zone?.prefix ?? "");
  const [err, setErr] = useState<string | null>(null);
  const save = () => {
    const body = { name: name.trim(), prefix: prefix.trim().toUpperCase() };
    (zone
      ? api(`/api/zones/${zone.id}`, { method: "PATCH", body }).then(() => zone.id)
      : api<{ id: string }>("/api/zones", { body }).then((r) => r.id)
    ).then(onClose, (e) => setErr((e as Error).message));
  };
  return (
    <div className="sheet-bg" {...backdrop(() => onClose())}>
      <div className="sheet center" role="dialog" aria-modal="true">
        <h3>{zone ? "Editar área" : "Nueva área"}</h3>
        <input
          autoFocus
          placeholder="Nombre (Salón, Terraza, Barra, Privado…)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          placeholder="Prefijo de las mesas (S, T, B…) — opcional"
          maxLength={4}
          value={prefix}
          onChange={(e) => setPrefix(e.target.value.toUpperCase())}
        />
        <p className="small">
          Con prefijo "T", las mesas de esta área serán T1, T2, T3… y se distinguen en cualquier
          pantalla y ticket.
        </p>
        {err && <p className="err">{err}</p>}
        <div className="row">
          {zone && (
            <button
              type="button"
              className="btn ghost"
              onClick={() =>
                api(`/api/zones/${zone.id}`, { method: "DELETE" }).then(
                  () => onClose(),
                  (e) => setErr((e as Error).message),
                )
              }
            >
              Eliminar
            </button>
          )}
          <button type="button" className="btn primary grow" disabled={!name.trim()} onClick={save}>
            {zone ? "Guardar" : "Crear área"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TableSheet({
  table,
  zones,
  defaultZone,
  onClose,
  onError,
}: {
  table: Table | null;
  zones: Zone[];
  defaultZone: string | null;
  onClose: () => void;
  onError: (m: string | null) => void;
}) {
  const [zoneId, setZoneId] = useState<string>(table?.zone_id ?? defaultZone ?? "");
  const prefixOf = (id: string) => zones.find((z) => z.id === id)?.prefix ?? "";
  // El número se captura con el teclado: solo dígitos; el prefijo del área se agrega solo
  const digitsOf = (num: string, zid: string) =>
    num.startsWith(prefixOf(zid)) && /^\d*$/.test(num.slice(prefixOf(zid).length))
      ? num.slice(prefixOf(zid).length)
      : null;
  const initial = table ? digitsOf(table.number, table.zone_id ?? "") : "";
  const [number, setNumber] = useState(initial ?? "");
  const [freeText, setFreeText] = useState(table && initial === null ? table.number : "");
  const [capacity, setCapacity] = useState(String(table?.capacity ?? 4));
  const [field, setField] = useState<"number" | "capacity">("number");
  const [vip, setVip] = useState(!!table?.vip);
  const [err, setErr] = useState<string | null>(null);
  const useText = table !== null && initial === null;
  const finalNumber = useText ? freeText.trim() : `${prefixOf(zoneId)}${number}`;
  const cap = Math.max(1, Number(capacity) || 0);

  const save = () => {
    const body = { zone_id: zoneId || null, number: finalNumber, capacity: cap, vip };
    (table
      ? api(`/api/tables/${table.id}`, { method: "PATCH", body })
      : api("/api/tables", { body })
    ).then(onClose, (e) => setErr((e as Error).message));
  };

  return (
    <div className="sheet-bg" {...backdrop(onClose)}>
      <div className="sheet center" style={{ width: "min(420px, 100%)" }}>
        <div className="row spread">
          <h3>{table ? `Mesa ${table.number}` : "Nueva mesa"}</h3>
          <select
            value={zoneId}
            onChange={(e) => setZoneId(e.target.value)}
            style={{ minHeight: 40 }}
          >
            <option value="">Sin área</option>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <button
            type="button"
            className={`opt grow ${field === "number" ? "on" : ""}`}
            style={{ height: 64, textAlign: "left" }}
            onClick={() => setField("number")}
          >
            <div style={{ fontSize: 12, opacity: 0.7 }}>Número</div>
            <div style={{ fontSize: 24, fontWeight: 600 }}>{finalNumber || "—"}</div>
          </button>
          <button
            type="button"
            className={`opt grow ${field === "capacity" ? "on" : ""}`}
            style={{ height: 64, textAlign: "left" }}
            onClick={() => setField("capacity")}
          >
            <div style={{ fontSize: 12, opacity: 0.7 }}>Personas</div>
            <div style={{ fontSize: 24, fontWeight: 600 }}>{capacity || "—"}</div>
          </button>
        </div>
        {useText ? (
          <input
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="Nombre de la mesa"
          />
        ) : field === "number" ? (
          <NumPad value={number} onChange={setNumber} max={4} />
        ) : (
          <NumPad value={capacity} onChange={setCapacity} max={2} />
        )}
        <div className="row">
          <button
            type="button"
            className={`opt grow ${vip ? "on" : ""}`}
            onClick={() => setVip(!vip)}
          >
            {vip ? "✓ " : ""}Mesa VIP
          </button>
          {table && (
            <button
              type="button"
              className="opt grow"
              onClick={() =>
                api(`/api/tables/${table.id}/service`, {
                  body: { out: table.status !== "fuera_de_servicio" },
                }).then(onClose, (e) => setErr((e as Error).message))
              }
            >
              {table.status === "fuera_de_servicio" ? "Poner en servicio" : "Fuera de servicio"}
            </button>
          )}
        </div>
        {err && <p className="err">{err}</p>}
        <div className="row">
          {table && (
            <button
              type="button"
              className="btn ghost"
              onClick={() =>
                api(`/api/tables/${table.id}`, { method: "DELETE" }).then(
                  () => {
                    onError(null);
                    onClose();
                  },
                  (e) => setErr((e as Error).message),
                )
              }
            >
              Eliminar
            </button>
          )}
          <button type="button" className="btn primary grow" disabled={!finalNumber} onClick={save}>
            {table ? "Guardar" : "Crear mesa"}
          </button>
        </div>
      </div>
    </div>
  );
}

function BulkSheet({
  zone,
  existing,
  onClose,
}: {
  zone: Zone;
  existing: string[];
  onClose: () => void;
}) {
  const nextNum =
    existing
      .map((n) => parseInt(n.slice(zone.prefix.length), 10))
      .filter(Number.isFinite)
      .reduce((m, n) => Math.max(m, n), 0) + 1;
  const [count, setCount] = useState("6");
  const [capacity, setCapacity] = useState("4");
  const [field, setField] = useState<"count" | "capacity">("count");
  const [err, setErr] = useState<string | null>(null);
  const n = Math.min(60, Math.max(0, Number(count) || 0));
  const last = zone.prefix + (nextNum + Math.max(0, n - 1));
  return (
    <div className="sheet-bg" {...backdrop(onClose)}>
      <div className="sheet center" style={{ width: "min(420px, 100%)" }}>
        <h3>Crear varias mesas en {zone.name}</h3>
        <div className="row">
          <button
            type="button"
            className={`opt grow ${field === "count" ? "on" : ""}`}
            style={{ height: 64, textAlign: "left" }}
            onClick={() => setField("count")}
          >
            <div style={{ fontSize: 12, opacity: 0.7 }}>¿Cuántas?</div>
            <div style={{ fontSize: 24, fontWeight: 600 }}>{count || "—"}</div>
          </button>
          <button
            type="button"
            className={`opt grow ${field === "capacity" ? "on" : ""}`}
            style={{ height: 64, textAlign: "left" }}
            onClick={() => setField("capacity")}
          >
            <div style={{ fontSize: 12, opacity: 0.7 }}>Personas por mesa</div>
            <div style={{ fontSize: 24, fontWeight: 600 }}>{capacity || "—"}</div>
          </button>
        </div>
        {field === "count" ? (
          <NumPad value={count} onChange={setCount} max={2} />
        ) : (
          <NumPad value={capacity} onChange={setCapacity} max={2} />
        )}
        <p className="small">
          {n > 0
            ? `Se crearán ${zone.prefix}${nextNum}${n > 1 ? ` a ${last}` : ""}.`
            : "Indica cuántas mesas."}
        </p>
        {err && <p className="err">{err}</p>}
        <button
          type="button"
          className="btn primary"
          disabled={n < 1}
          onClick={() =>
            api("/api/tables/bulk", {
              body: { zone_id: zone.id, count: n, capacity: Math.max(1, Number(capacity) || 4) },
            }).then(onClose, (e) => setErr((e as Error).message))
          }
        >
          Crear {n} mesa(s)
        </button>
      </div>
    </div>
  );
}
