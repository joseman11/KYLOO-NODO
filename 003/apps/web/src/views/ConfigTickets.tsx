import { useEffect, useRef, useState } from "react";
import { api, useLive } from "../api";
import { SubTabs, useSize } from "../fit";

const CHARS = [["-", "Guiones"], ["=", "Doble línea"], ["*", "Asteriscos"], [".", "Puntos"], ["_", "Línea baja"], ["~", "Ondas"]] as const;

interface SettingsData { ticket_separator: string; ticket_group_categories: boolean; ticket_footer: string; }
interface Preview { comanda: string[]; bill: string[]; }

/**
 * Estilo de los tickets: separadores, agrupar la cuenta por categoría y texto al pie.
 * La vista previa se genera con el mismo código que imprime, así lo que ves es lo que sale.
 */
export function Tickets() {
  const saved = useLive(() => api<SettingsData>("/api/settings"), []);
  const [sep, setSep] = useState<string | null>(null);
  const [group, setGroup] = useState<boolean | null>(null);
  const [footer, setFooter] = useState<string | null>(null);
  const [paper, setPaper] = useState<"58" | "80">("80");
  const [which, setWhich] = useState<"comanda" | "bill">("comanda");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const cur = {
    sep: sep ?? saved.data?.ticket_separator ?? "-",
    group: group ?? saved.data?.ticket_group_categories ?? false,
    footer: footer ?? saved.data?.ticket_footer ?? "",
  };

  useEffect(() => {
    if (!saved.data) return;
    const t = setTimeout(() => {
      api<Preview>("/api/ticket-preview", { body: { sep: cur.sep, groupCategories: cur.group, footer: cur.footer, paper: Number(paper) } }).then(setPreview, () => undefined);
    }, 150);
    return () => clearTimeout(t);
  }, [saved.data, cur.sep, cur.group, cur.footer, paper]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = () =>
    api("/api/settings", { method: "PUT", body: { ticket_separator: cur.sep, ticket_group_categories: cur.group, ticket_footer: cur.footer } }).then(
      () => { setMsg("Guardado"); saved.reload(); },
      (e) => setMsg((e as Error).message),
    );

  const cols = paper === "58" ? 32 : 42;
  const lines = which === "comanda" ? preview?.comanda : preview?.bill;

  // El papel se reduce para caber completo en el espacio disponible (sin desplazamiento)
  const [boxRef, box] = useSize<HTMLDivElement>();
  const paperRef = useRef<HTMLPreElement>(null);
  const natural = paperRef.current?.scrollHeight ?? 0;
  const scale = box.h > 0 && natural > 0 ? Math.min(1, box.h / natural) : 1;

  return (
    <div className="split">
      <section className="card col" style={{ width: 320, flex: "none", alignSelf: "flex-start", gap: 6 }}>
        <div className="small">Línea separadora de los tickets</div>
        <div className="row wrap" style={{ gap: 6 }}>
          {CHARS.map(([c, label]) => (
            <button key={c} className={`opt ${cur.sep === c ? "on" : ""}`} style={{ minHeight: 42, padding: "0 8px", fontFamily: "ui-monospace, monospace", flex: "1 1 30%" }} title={label} onClick={() => setSep(c)}>{c.repeat(5)}</button>
          ))}
        </div>
        <button className={`opt ${cur.group ? "on" : ""}`} style={{ textAlign: "left", minHeight: 44 }} onClick={() => setGroup(!cur.group)}>{cur.group ? "✓ " : ""}Agrupar la cuenta por categoría</button>
        <textarea rows={2} placeholder="Texto al pie (WiFi, redes…) · una línea por renglón" value={cur.footer} onChange={(e) => setFooter(e.target.value)} style={{ resize: "none", overflow: "hidden", fontFamily: "inherit", minHeight: 64 }} />
        <div className="row">
          <button className="btn primary grow" onClick={save}>Guardar</button>
          {msg && <span className="small">{msg}</span>}
        </div>
      </section>

      <section className="card fillcard">
        <div className="row spread" style={{ flex: "none" }}>
          <SubTabs value={which} onChange={setWhich} tabs={[{ id: "comanda", label: "Comanda (cocina)" }, { id: "bill", label: "Cuenta del cliente" }]} />
          <SubTabs value={paper} onChange={setPaper} tabs={[{ id: "58", label: "58 mm" }, { id: "80", label: "80 mm" }]} />
        </div>
        <div ref={boxRef} style={{ flex: 1, minHeight: 0, display: "flex", justifyContent: "center", overflow: "hidden" }}>
          <pre ref={paperRef} style={{ transform: `scale(${scale})`, transformOrigin: "top center", flex: "none",  fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12.5, lineHeight: 1.3, whiteSpace: "pre", background: "#fff", border: "1px solid var(--color-mist)", borderRadius: 8, padding: "10px 12px", width: `${cols + 4}ch`, margin: 0, overflow: "hidden", userSelect: "text" }}>
            {(lines ?? []).join("\n")}
          </pre>
        </div>
      </section>
    </div>
  );
}
