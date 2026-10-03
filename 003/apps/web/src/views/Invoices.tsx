import { useState } from "react";
import { backdrop } from "../sheet";
import { ApiError, api, money, useLive } from "../api";
import { PagedRows } from "../fit";

interface Invoice {
  id: string;
  account_id: string;
  rfc: string;
  razon_social: string;
  total_cents: number;
  status: string;
  provider: string;
  uuid: string | null;
  serie: string;
  folio: number;
  issued_at: number;
  cancel_reason: string | null;
}

const USO = [
  ["G03", "Gastos en general"],
  ["G01", "Adquisición de mercancías"],
  ["S01", "Sin efectos fiscales"],
  ["P01", "Por definir"],
] as const;

/** Descarga con sesión: el XML/HTML requieren autorización, por eso se piden con fetch y se abren como archivo. */
async function download(path: string, filename: string | null) {
  const session = JSON.parse(localStorage.getItem("003.session") ?? "null") as {
    token: string;
  } | null;
  const res = await fetch(path, { headers: { Authorization: `Bearer ${session?.token ?? ""}` } });
  if (!res.ok) throw new Error("No se pudo descargar");
  const url = URL.createObjectURL(await res.blob());
  if (filename) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  } else {
    window.open(url, "_blank");
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function InvoiceList() {
  const list = useLive(() => api<Invoice[]>("/api/invoices"), ["invoice.issued"]);
  const [err, setErr] = useState<string | null>(null);
  const [cancel, setCancel] = useState<Invoice | null>(null);
  const [resend, setResend] = useState<Invoice | null>(null);

  return (
    <section className="card fillcard">
      {err && <p className="err">{err}</p>}
      <PagedRows
        items={list.data ?? []}
        rowH={56}
        empty={<p className="muted">Aún no hay facturas</p>}
        head={
          <tr>
            <th>Folio</th>
            <th>Cliente</th>
            <th className="r">Total</th>
            <th>Estado</th>
            <th />
          </tr>
        }
        row={(i) => (
          <>
            <td className="num">
              {i.serie}-{i.folio}
            </td>
            <td>
              {i.razon_social}
              <div className="small">{i.rfc}</div>
            </td>
            <td className="r num">{money(i.total_cents)}</td>
            <td>
              <span className={`tag ${i.status === "cancelada" ? "ember" : ""}`}>{i.status}</span>
              {i.provider === "prueba" && <div className="small">prueba</div>}
            </td>
            <td className="r">
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() =>
                    download(`/api/invoices/${i.id}/xml`, `${i.serie}-${i.folio}.xml`).catch((e) =>
                      setErr((e as Error).message),
                    )
                  }
                >
                  XML
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() =>
                    download(`/api/invoices/${i.id}/html`, null).catch((e) =>
                      setErr((e as Error).message),
                    )
                  }
                >
                  Imprimir / PDF
                </button>
                {i.status === "emitida" && (
                  <button type="button" className="btn sm" onClick={() => setResend(i)}>
                    Reenviar
                  </button>
                )}
                {i.status === "emitida" && (
                  <button type="button" className="btn ghost sm" onClick={() => setCancel(i)}>
                    Cancelar
                  </button>
                )}
              </div>
            </td>
          </>
        )}
      />
      {cancel && (
        <CancelInvoice
          invoice={cancel}
          onClose={() => {
            setCancel(null);
            list.reload();
          }}
        />
      )}
      {resend && (
        <ResendInvoice
          invoice={resend}
          onClose={() => {
            setResend(null);
            list.reload();
          }}
        />
      )}
    </section>
  );
}

const MOTIVOS = [
  ["02", "Error de captura (sin relación)"],
  ["01", "Error con relación a otra factura"],
  ["03", "La operación no se realizó"],
  ["04", "Operación nominativa en factura global"],
] as const;

function CancelInvoice({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const [motivo, setMotivo] = useState("02");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="sheet-bg" {...backdrop(onClose)}>
      <div className="sheet center" role="dialog" aria-modal="true">
        <h3>
          Cancelar factura {invoice.serie}-{invoice.folio}
        </h3>
        <div className="col">
          {MOTIVOS.map(([k, l]) => (
            <button
              type="button"
              key={k}
              className={`opt ${motivo === k ? "on" : ""}`}
              style={{ textAlign: "left" }}
              onClick={() => setMotivo(k)}
            >
              {k} · {l}
            </button>
          ))}
        </div>
        <input
          placeholder="Nota (opcional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        {err && <p className="err">{err}</p>}
        <button
          type="button"
          className="btn primary"
          onClick={() =>
            api(`/api/invoices/${invoice.id}/cancel`, {
              body: { motivo, note: note || undefined },
            }).then(onClose, (e) => setErr((e as Error).message))
          }
        >
          Cancelar factura
        </button>
      </div>
    </div>
  );
}

function ResendInvoice({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="sheet-bg" {...backdrop(onClose)}>
      <div className="sheet center" role="dialog" aria-modal="true">
        <h3>
          Reenviar {invoice.serie}-{invoice.folio}
        </h3>
        <input
          inputMode="email"
          placeholder="correo@cliente.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <p className="small">
          Se publica el evento de reenvío para el sistema de correo conectado. Mientras no haya uno
          conectado, descarga el XML o imprime el PDF.
        </p>
        {err && <p className="err">{err}</p>}
        <button
          type="button"
          className="btn primary"
          disabled={!email.includes("@")}
          onClick={() =>
            api(`/api/invoices/${invoice.id}/resend`, { body: { email } }).then(onClose, (e) =>
              setErr((e as Error).message),
            )
          }
        >
          Reenviar
        </button>
      </div>
    </div>
  );
}

/** Solicitud de factura de una cuenta ya cobrada: datos fiscales del cliente. */
export function FiscalSheet({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const [f, setF] = useState({
    rfc: "",
    razon_social: "",
    regimen_fiscal: "601",
    cp: "",
    uso_cfdi: "G03",
    email: "",
  });
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ serie: string; folio: number; sandbox: boolean } | null>(null);
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });

  const submit = () =>
    api<{ serie: string; folio: number; sandbox: boolean }>(`/api/accounts/${accountId}/invoice`, {
      body: { fiscal: { ...f, email: f.email || undefined } },
    }).then(setDone, (e) =>
      setErr(
        e instanceof ApiError && e.code === "emisor_no_configurado"
          ? "Falta configurar los datos fiscales del establecimiento (Configuración → Ajustes)."
          : e instanceof ApiError && e.code === "validacion"
            ? "Revisa RFC (12 o 13 caracteres), régimen (3 dígitos) y código postal (5 dígitos)."
            : (e as Error).message,
      ),
    );

  if (done) {
    return (
      <div className="sheet-bg">
        <div className="sheet center">
          <h2>
            Factura {done.serie}-{done.folio}
          </h2>
          {done.sandbox && (
            <p className="small">
              <strong>Prueba — sin validez fiscal.</strong> Conecta un proveedor de timbrado (PAC)
              para emitir facturas oficiales.
            </p>
          )}
          <button type="button" className="btn primary" onClick={onClose}>
            Listo
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="sheet-bg" {...backdrop(onClose)}>
      <div className="sheet center" role="dialog" aria-modal="true">
        <h3>Datos fiscales del cliente</h3>
        <input
          placeholder="RFC"
          autoCapitalize="characters"
          value={f.rfc}
          onChange={(e) => set("rfc", e.target.value.toUpperCase())}
        />
        <input
          placeholder="Razón social"
          value={f.razon_social}
          onChange={(e) => set("razon_social", e.target.value)}
        />
        <div className="row">
          <input
            className="grow"
            placeholder="Régimen (601)"
            inputMode="numeric"
            value={f.regimen_fiscal}
            onChange={(e) => set("regimen_fiscal", e.target.value)}
          />
          <input
            className="grow"
            placeholder="C.P."
            inputMode="numeric"
            value={f.cp}
            onChange={(e) => set("cp", e.target.value)}
          />
        </div>
        <select value={f.uso_cfdi} onChange={(e) => set("uso_cfdi", e.target.value)}>
          {USO.map(([k, l]) => (
            <option key={k} value={k}>
              {k} · {l}
            </option>
          ))}
        </select>
        <input
          placeholder="Correo (opcional)"
          inputMode="email"
          value={f.email}
          onChange={(e) => set("email", e.target.value)}
        />
        {err && <p className="err">{err}</p>}
        <div className="row">
          <button type="button" className="btn grow" onClick={onClose}>
            Ahora no
          </button>
          <button
            type="button"
            className="btn primary grow"
            disabled={!f.rfc || !f.razon_social || !f.cp}
            onClick={submit}
          >
            Facturar
          </button>
        </div>
      </div>
    </div>
  );
}
