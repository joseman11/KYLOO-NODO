import { useEffect, useState } from "react";
import { api, isNativeApp, serverBase, setServerBase } from "./api";

/**
 * Cambio de servidor (plan 07): si el servidor del local deja de responder, la tablet busca la reserva y, en cuanto
 * esta ya es el servidor principal, se pasa sola. La lista de servidores se aprende del propio servidor
 * (`/api/standby/peers`) y se guarda en el dispositivo para poder usarla cuando el principal ya no contesta.
 *
 * Solo la app envoltorio lo hace: un navegador no puede preguntar a otro origen (CORS/CSP). Las tablets con navegador usan el
 * nombre `nodo.local`, que la reserva anuncia en cuanto se promueve.
 */
const LIST_KEY = "003.servers";

export const knownServers = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(LIST_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};
export function rememberServers(urls: string[]) {
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify([...new Set(urls)].slice(0, 4)));
  } catch {
    /* sin almacenamiento */
  }
}

export interface Probe {
  url: string;
  /** `primary` atiende comandas; `standby` es una reserva sin promover; `null` no contesta. */
  role: "primary" | "standby" | null;
}

/** Pregunta a cada servidor quién es. Un servidor que no contesta en 2,5 s cuenta como caído. */
export async function probeServers(urls: string[], f: typeof fetch = fetch): Promise<Probe[]> {
  return Promise.all(
    urls.map(async (url): Promise<Probe> => {
      try {
        const r = await f(`${url}/api/health`, { signal: AbortSignal.timeout(2500) });
        const j = (await r.json()) as { ok?: boolean; role?: string };
        if (!r.ok || !j.ok) return { url, role: null };
        return { url, role: j.role === "standby" ? "standby" : "primary" };
      } catch {
        return { url, role: null };
      }
    }),
  );
}

/** Qué hacer con lo que se encontró: irse a un principal, avisar de una reserva sin promover, o seguir esperando. */
export function decide(probes: Probe[]): { go: string | null; standby: string | null } {
  return {
    go: probes.find((p) => p.role === "primary")?.url ?? null,
    standby: probes.find((p) => p.role === "standby")?.url ?? null,
  };
}

const sameOrigin = (u: string) => u === (serverBase() || location.origin);

/** Aprende la reserva del servidor mientras este responde. */
export async function learnServers() {
  try {
    const { standby_url } = await api<{ standby_url: string | null }>("/api/standby/peers");
    const self = serverBase() || location.origin;
    rememberServers([self, ...(standby_url ? [standby_url] : []), ...knownServers()]);
  } catch {
    /* sin red: se conserva lo ya sabido */
  }
}

/**
 * Mientras no hay conexión con el servidor (más de `afterMs`), busca a dónde irse cada 5 s. Devuelve lo que se sabe para
 * avisar a quien atiende: `standbyUrl` es una reserva encontrada que todavía no se ha promovido.
 */
export function useFailover(active: boolean, online: boolean, afterMs = 6000) {
  const [standbyUrl, setStandbyUrl] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (!active || online) {
      setStandbyUrl(null);
      setSearching(false);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      const others = knownServers().filter((u) => !sameOrigin(u));
      if (!others.length) return;
      setSearching(true);
      const found = decide(await probeServers(others));
      if (!alive) return;
      setStandbyUrl(found.standby);
      if (found.go) {
        if (isNativeApp()) {
          setServerBase(found.go);
          location.reload();
        } else location.replace(found.go);
        return;
      }
      timer = setTimeout(run, 5000);
    };
    timer = setTimeout(run, afterMs);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [active, online, afterMs]);
  return { standbyUrl, searching };
}
