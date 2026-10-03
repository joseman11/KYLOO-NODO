import { useEffect, useState } from "react";
import { api, useLive } from "../api";
import { PagedRows, SubTabs } from "../fit";
import { Promotions, QrCodes } from "./ConfigExtra";
import { Settings } from "./ConfigSettings";
import { Cloud, Integrations } from "./ConfigCloud";
import { Connect } from "./ConfigConnect";
import { Areas, Categories, Products } from "./ConfigMenu";
import { Tickets } from "./ConfigTickets";
import { Salon } from "./Salon";
import { Users } from "./ConfigUsers";

interface Station {
  id: string;
  name: string;
  primary_printer_id: string | null;
  secondary_printer_id: string | null;
}
interface Printer {
  id: string;
  name: string;
  kind: string;
  host: string | null;
  port: number;
  paper_width: number;
  has_drawer: number;
}

interface Found {
  host: string;
  port: number;
  configured: { id: string; name: string } | null;
}

type Tab =
  | "productos"
  | "categorias"
  | "areas"
  | "impresoras"
  | "tickets"
  | "mesas"
  | "promos"
  | "qr"
  | "integraciones"
  | "nube"
  | "conectar"
  | "ajustes"
  | "equipo";

/** Configuración dividida en pestañas: cada sección ocupa la pantalla completa, sin desplazamiento. */
export function Config() {
  const [tab, setTab] = useState<Tab>("productos");
  const stations = useLive(() => api<Station[]>("/api/stations"), []);
  const printers = useLive(() => api<Printer[]>("/api/printers"), []);
  const [err, setErr] = useState<string | null>(null);
  const [finder, setFinder] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const run = (p: Promise<unknown>, after: () => void) =>
    p.then(
      () => {
        setErr(null);
        after();
      },
      (e) => setErr((e as Error).message),
    );

  return (
    <div className="view">
      <SubTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "productos", label: "Productos" },
          { id: "categorias", label: "Categorías" },
          { id: "areas", label: "Áreas" },
          { id: "impresoras", label: "Impresoras" },
          { id: "tickets", label: "Tickets" },
          { id: "mesas", label: "Salón y mesas" },
          { id: "promos", label: "Promociones" },
          { id: "qr", label: "Menú QR" },
          { id: "integraciones", label: "Integraciones" },
          { id: "equipo", label: "Equipo" },
          { id: "conectar", label: "Conectar" },
          { id: "nube", label: "Nube" },
          { id: "ajustes", label: "Ajustes" },
        ]}
      />
      {err && (
        <p className="err" style={{ flex: "none" }}>
          {err}
        </p>
      )}

      {tab === "productos" && <Products />}
      {tab === "categorias" && <Categories />}
      {finder && (
        <PrinterFinder onClose={() => setFinder(false)} onAdded={() => printers.reload()} />
      )}
      {tab === "conectar" && <Connect />}
      {tab === "areas" && <Areas />}

      {tab === "impresoras" && (
        <div className="split">
          <section className="card fillcard">
            <div className="row spread" style={{ flex: "none" }}>
              <h3>Impresoras</h3>
              <button className="btn sm" onClick={() => setFinder(true)}>
                Buscar en la red
              </button>
            </div>
            {testMsg && (
              <p className="small" style={{ flex: "none" }}>
                {testMsg}
              </p>
            )}
            <PagedRows
              fixed
              items={printers.data ?? []}
              rowH={52}
              row={(p) => (
                <td style={{ padding: 0 }}>
                  <div className="row spread" style={{ height: 52 }}>
                    <span className="ellipsis">
                      {p.name}{" "}
                      <span className="small">
                        {p.kind} · {p.host ?? "sin IP"}:{p.port} · {p.paper_width}mm
                      </span>
                    </span>
                    <div className="row" style={{ flex: "none", gap: 6 }}>
                      {p.kind === "caja" && (
                        <button
                          className={`btn sm ${p.has_drawer ? "" : "ghost"}`}
                          title="Cajón de dinero conectado a esta impresora"
                          onClick={() =>
                            run(
                              api(`/api/printers/${p.id}`, {
                                method: "PATCH",
                                body: { has_drawer: !p.has_drawer },
                              }),
                              printers.reload,
                            )
                          }
                        >
                          Cajón: {p.has_drawer ? "sí" : "no"}
                        </button>
                      )}
                      <button
                        className="btn ghost sm"
                        onClick={() =>
                          api<{ ok: boolean; error?: string }>(`/api/printers/${p.id}/test`, {
                            method: "POST",
                            body: {},
                          }).then(
                            (r) =>
                              setTestMsg(
                                r.ok
                                  ? `${p.name}: la prueba se imprimió`
                                  : `${p.name}: no respondió (${r.error ?? "sin detalle"}); se reintentará`,
                              ),
                            (e) => setTestMsg((e as Error).message),
                          )
                        }
                      >
                        Probar
                      </button>
                      <button
                        className="btn ghost sm"
                        onClick={() =>
                          run(api(`/api/printers/${p.id}`, { method: "DELETE" }), printers.reload)
                        }
                      >
                        Eliminar
                      </button>
                    </div>
                  </div>
                </td>
              )}
            />
            <PrinterForm onSaved={printers.reload} onError={setErr} />
          </section>
          <section className="card fillcard" style={{ maxWidth: 520 }}>
            <h3>Impresora de cada estación</h3>
            <PagedRows
              fixed
              items={stations.data ?? []}
              rowH={56}
              row={(s) => (
                <td style={{ padding: 0 }}>
                  <div className="row" style={{ height: 56 }}>
                    <span style={{ width: 100 }} className="ellipsis">
                      {s.name}
                    </span>
                    {(["primary_printer_id", "secondary_printer_id"] as const).map((f) => (
                      <select
                        key={f}
                        className="grow"
                        value={s[f] ?? ""}
                        onChange={(e) =>
                          run(
                            api(`/api/stations/${s.id}`, {
                              method: "PATCH",
                              body: { [f]: e.target.value || null },
                            }),
                            stations.reload,
                          )
                        }
                      >
                        <option value="">
                          {f === "primary_printer_id" ? "Principal: KDS" : "Secundaria: —"}
                        </option>
                        {printers.data?.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    ))}
                  </div>
                </td>
              )}
            />
          </section>
        </div>
      )}

      {tab === "tickets" && <Tickets />}

      {tab === "mesas" && <Salon />}

      {tab === "promos" && <Promotions />}
      {tab === "qr" && <QrCodes />}
      {tab === "integraciones" && <Integrations />}
      {tab === "nube" && <Cloud />}
      {tab === "ajustes" && <Settings />}
      {tab === "equipo" && <Users />}
    </div>
  );
}

/** Busca impresoras de red (puerto 9100) en las redes del equipo y deja agregarlas con un toque. */
function PrinterFinder({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [found, setFound] = useState<Found[] | null>(null);
  const [scanning, setScanning] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { name: string; kind: string }>>({});
  const scan = () => {
    setScanning(true);
    setErr(null);
    api<{ found: Found[] }>("/api/printers/discover", { method: "POST", body: {} })
      .then(
        (r) => setFound(r.found),
        (e) => setErr((e as Error).message),
      )
      .finally(() => setScanning(false));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: se busca una vez al abrir
  useEffect(scan, []);
  const draft = (f: Found) =>
    drafts[f.host] ?? { name: `Impresora ${f.host.split(".").pop()}`, kind: "cocina" };
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet center" onClick={(e) => e.stopPropagation()}>
        <h3>Impresoras en la red</h3>
        {scanning && <p className="small">Buscando… tarda unos segundos.</p>}
        {err && <p className="err">{err}</p>}
        {found && !scanning && found.length === 0 && (
          <p className="small">
            No se encontró ninguna. Revisa que estén encendidas, conectadas por cable o WiFi a esta
            misma red y con el puerto 9100 habilitado.
          </p>
        )}
        {found?.map((f) => (
          <div key={f.host} className="row" style={{ gap: 6 }}>
            <span className="num" style={{ minWidth: 120 }}>
              {f.host}
            </span>
            {f.configured ? (
              <span className="small">ya agregada: {f.configured.name}</span>
            ) : (
              <>
                <input
                  value={draft(f).name}
                  style={{ width: 150 }}
                  onChange={(e) =>
                    setDrafts({ ...drafts, [f.host]: { ...draft(f), name: e.target.value } })
                  }
                />
                <select
                  value={draft(f).kind}
                  onChange={(e) =>
                    setDrafts({ ...drafts, [f.host]: { ...draft(f), kind: e.target.value } })
                  }
                >
                  {["cocina", "bar", "caja", "recepcion", "admin"].map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
                <button
                  className="btn sm primary"
                  onClick={() =>
                    api("/api/printers", {
                      body: {
                        name: draft(f).name,
                        kind: draft(f).kind,
                        host: f.host,
                        port: f.port,
                      },
                    }).then(
                      () => {
                        onAdded();
                        scan();
                      },
                      (e) => setErr((e as Error).message),
                    )
                  }
                >
                  Agregar
                </button>
              </>
            )}
          </div>
        ))}
        <div className="row">
          <button className="btn" disabled={scanning} onClick={scan}>
            Buscar de nuevo
          </button>
          <button className="btn primary" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

function PrinterForm({ onSaved, onError }: { onSaved: () => void; onError: (m: string) => void }) {
  const [f, setF] = useState({ name: "", kind: "cocina", host: "", paper: "80" });
  return (
    <div className="row wrap" style={{ flex: "none" }}>
      <input
        placeholder="Nombre"
        style={{ width: 150 }}
        value={f.name}
        onChange={(e) => setF({ ...f, name: e.target.value })}
      />
      <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
        {["cocina", "bar", "caja", "recepcion", "admin"].map((k) => (
          <option key={k}>{k}</option>
        ))}
      </select>
      <input
        placeholder="IP (192.168.1.50)"
        style={{ width: 150 }}
        value={f.host}
        onChange={(e) => setF({ ...f, host: e.target.value })}
      />
      <select value={f.paper} onChange={(e) => setF({ ...f, paper: e.target.value })}>
        <option value="80">80 mm</option>
        <option value="58">58 mm</option>
      </select>
      <button
        className="btn"
        disabled={!f.name}
        onClick={() =>
          api("/api/printers", {
            body: {
              name: f.name,
              kind: f.kind,
              host: f.host || null,
              paper_width: Number(f.paper),
            },
          }).then(
            () => {
              setF({ ...f, name: "", host: "" });
              onSaved();
            },
            (e) => onError((e as Error).message),
          )
        }
      >
        Agregar
      </button>
    </div>
  );
}
