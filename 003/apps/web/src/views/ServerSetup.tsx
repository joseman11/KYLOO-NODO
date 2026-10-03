import { API_CONTRACT } from "@003/shared";
import { useState } from "react";
import { setServerBase } from "../api";
import { KylooLogo, NodoLogo, NodoMark } from "../Logo";
import { WaveCanvas } from "../WaveCanvas";

/** «192.168.1.20» → `http://192.168.1.20:3003` (puerto por defecto de Nodo; admite esquema y puerto escritos). */
export function normalizeServer(input: string): string | null {
  const t = input.trim().replace(/\/+$/, "");
  if (!t) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(t) ? t : `http://${t}`);
    if (!u.hostname) return null;
    return `${u.protocol}//${u.hostname}:${u.port || "3003"}`;
  } catch {
    return null;
  }
}

export type ProbeResult = { ok: true; name: string | null } | { ok: false; message: string };

/** Comprueba que en esa dirección hay un servidor de Nodo y que habla el mismo contrato que esta interfaz. */
export async function probeServer(
  base: string,
  fetchFn: typeof fetch = fetch,
): Promise<ProbeResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetchFn(`${base}/api/health`, { signal: ctl.signal });
    const h = (await r.json().catch(() => null)) as { ok?: boolean; contract?: number } | null;
    if (!r.ok || !h?.ok)
      return { ok: false, message: "Esa dirección no responde como un servidor de Nodo" };
    if (h.contract !== API_CONTRACT)
      return {
        ok: false,
        message:
          "Este servidor es de otra versión que la app: actualiza la app o el servidor para que coincidan",
      };
    const info = await fetchFn(`${base}/api/auth/info`).then(
      (x) => x.json() as Promise<{ name: string | null }>,
      () => null,
    );
    return { ok: true, name: info?.name ?? null };
  } catch {
    return {
      ok: false,
      message:
        "No se pudo conectar. Revisa que la tablet esté en la misma red que el servidor y que la dirección sea correcta",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pantalla de conexión de la app envoltorio: la primera vez (o al cambiar de servidor) se indica dónde está el servidor
 * del local. La dirección se ve en el servidor, en Configuración → Conectar.
 */
export function ServerSetup({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setError(null);
    const base = normalizeServer(value);
    if (!base) return setError("Escribe la dirección del servidor, por ejemplo 192.168.1.20");
    setBusy(true);
    const r = await probeServer(base);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setServerBase(base);
    onDone();
  };

  return (
    <div className="login-wrap">
      <div className="login-hero" aria-hidden="true">
        <WaveCanvas />
        <a className="by-kyloo" href="https://kyloo.com.mx/" target="_blank" rel="noreferrer">
          <span>by</span>
          <KylooLogo width={74} />
        </a>
        <div className="mark">
          <NodoLogo size="clamp(220px, 32vw, 440px)" color="#f4f2ec" />
        </div>
      </div>
      <div className="login">
        <div className="login-top">
          <div className="row" style={{ gap: 10, minWidth: 0 }}>
            <NodoMark size={36} />
            <strong className="ellipsis">Nodo</strong>
          </div>
        </div>
        <div className="login-hello">
          <div>
            <h2>Conectar con el servidor</h2>
            <p className="small">
              Escribe la dirección del equipo donde está Nodo. La ves en ese equipo, en
              Configuración → Conectar.
            </p>
          </div>
        </div>
        <form
          className="col"
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <input
            placeholder="Dirección (192.168.1.20)"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            autoFocus
          />
          {error && <p className="err">{error}</p>}
          <button className="btn primary" type="submit" disabled={busy || !value.trim()}>
            {busy ? "Conectando…" : "Conectar"}
          </button>
        </form>
      </div>
    </div>
  );
}
