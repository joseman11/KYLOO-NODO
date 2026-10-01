import { useState } from "react";
import { api, useLive } from "../api";
import { SubTabs } from "../fit";

interface SettingsData {
  establishment_name: string; discount_limit_pct: number;
  fiscal_rfc: string; fiscal_name: string; fiscal_regimen: string; fiscal_cp: string;
  service_charge_pct: number; service_charge_min_guests: number;
  tip_policy: "individual" | "pool"; tip_roles: string; tip_support_pct: number;
}

type Tab = "general" | "cobro" | "propinas" | "fiscal";
const ROLES = [["mesero", "Meseros"], ["cocina", "Cocina"], ["bar", "Bar"]] as const;

/** Ajustes del establecimiento en pestañas: general, cobro (servicio), propinas y datos fiscales. */
export function Settings() {
  const s = useLive(() => api<SettingsData>("/api/settings"), []);
  const [tab, setTab] = useState<Tab>("general");
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const val = (k: keyof SettingsData) => edit[k] ?? String(s.data?.[k] ?? "");
  const set = (k: string, v: string) => { setEdit({ ...edit, [k]: v }); setMsg(null); };

  const roles = (() => { try { return JSON.parse(edit.tip_roles ?? s.data?.tip_roles ?? "{}") as Record<string, number>; } catch { return {} as Record<string, number>; } })();
  const setRole = (r: string, v: string) => set("tip_roles", JSON.stringify({ ...roles, [r]: Math.min(100, Math.max(0, Number(v) || 0)) }));
  const policy = (edit.tip_policy ?? s.data?.tip_policy ?? "individual") as "individual" | "pool";

  const save = (keys: (keyof SettingsData)[]) => {
    const body: Record<string, string | number> = {};
    for (const k of keys) {
      const v = k === "tip_policy" ? policy : val(k);
      if (String(k).startsWith("fiscal_") && !v) continue; // aún no configurado
      body[k] = ["discount_limit_pct", "service_charge_pct", "service_charge_min_guests", "tip_support_pct"].includes(k) ? Number(v) : v;
    }
    api("/api/settings", { method: "PUT", body }).then(() => { setMsg("Guardado"); setEdit({}); s.reload(); }, (e) => setMsg((e as Error).message));
  };

  return (
    <div className="view">
      <SubTabs value={tab} onChange={setTab} tabs={[{ id: "general", label: "General" }, { id: "cobro", label: "Cobro y servicio" }, { id: "propinas", label: "Propinas" }, { id: "fiscal", label: "Datos fiscales" }]} />
      <section className="card col" style={{ maxWidth: 520, alignSelf: "flex-start", width: "100%" }}>
        {tab === "general" && (
          <>
            <input value={val("establishment_name")} placeholder="Nombre en tickets" onChange={(e) => set("establishment_name", e.target.value)} />
            <input inputMode="numeric" value={val("discount_limit_pct")} placeholder="Límite de descuento sin autorización (%)" onChange={(e) => set("discount_limit_pct", e.target.value)} />
            <p className="small">Un mesero puede dar descuentos hasta ese porcentaje; por encima requiere el PIN de un gerente.</p>
            <button className="btn primary" onClick={() => save(["establishment_name", "discount_limit_pct"])}>Guardar</button>
          </>
        )}
        {tab === "cobro" && (
          <>
            <div className="small">Cargo por servicio (porcentaje sobre la cuenta; 0 = no se cobra)</div>
            <div className="row">
              <input className="grow" inputMode="decimal" value={val("service_charge_pct")} placeholder="% de servicio" onChange={(e) => set("service_charge_pct", e.target.value)} />
              <input className="grow" inputMode="numeric" value={val("service_charge_min_guests")} placeholder="Desde N personas" onChange={(e) => set("service_charge_min_guests", e.target.value)} />
            </div>
            <p className="small">Ejemplo: 10 % y desde 8 personas cobra el servicio solo a los grupos grandes. Un gerente puede dispensarlo en una cuenta.</p>
            <button className="btn primary" onClick={() => save(["service_charge_pct", "service_charge_min_guests"])}>Guardar</button>
          </>
        )}
        {tab === "propinas" && (
          <>
            <div className="row">
              <button className={`opt grow ${policy === "individual" ? "on" : ""}`} onClick={() => set("tip_policy", "individual")}>Cada mesero conserva lo suyo</button>
              <button className={`opt grow ${policy === "pool" ? "on" : ""}`} onClick={() => set("tip_policy", "pool")}>Fondo común</button>
            </div>
            {policy === "individual" ? (
              <>
                <input inputMode="decimal" value={val("tip_support_pct")} placeholder="% que cada mesero aporta al personal de apoyo" onChange={(e) => set("tip_support_pct", e.target.value)} />
                <p className="small">El aporte se reparte entre cocina y bar según su peso, y dentro de cada rol por horas trabajadas (checador).</p>
              </>
            ) : (
              <p className="small">Todas las propinas se juntan y se reparten por rol y, dentro del rol, por horas trabajadas.</p>
            )}
            <div className="small">Peso de cada rol en el reparto</div>
            <div className="row">{ROLES.map(([r, l]) => <label key={r} className="col grow small" style={{ gap: 2 }}>{l}<input inputMode="numeric" value={String(roles[r] ?? 0)} onChange={(e) => setRole(r, e.target.value)} /></label>)}</div>
            <button className="btn primary" onClick={() => save(["tip_policy", "tip_support_pct", "tip_roles"])}>Guardar</button>
          </>
        )}
        {tab === "fiscal" && (
          <>
            <input value={val("fiscal_rfc")} placeholder="RFC del establecimiento" autoCapitalize="characters" onChange={(e) => set("fiscal_rfc", e.target.value.toUpperCase())} />
            <input value={val("fiscal_name")} placeholder="Razón social" onChange={(e) => set("fiscal_name", e.target.value)} />
            <div className="row"><input className="grow" value={val("fiscal_regimen")} placeholder="Régimen (601)" inputMode="numeric" onChange={(e) => set("fiscal_regimen", e.target.value)} /><input className="grow" value={val("fiscal_cp")} placeholder="C.P. de expedición" inputMode="numeric" onChange={(e) => set("fiscal_cp", e.target.value)} /></div>
            <button className="btn primary" onClick={() => save(["fiscal_rfc", "fiscal_name", "fiscal_regimen", "fiscal_cp"])}>Guardar datos fiscales</button>
          </>
        )}
        {msg && <p className="small" style={{ color: "var(--color-ink)" }}>{msg}</p>}
      </section>
    </div>
  );
}
