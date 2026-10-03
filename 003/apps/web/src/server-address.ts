import { API_CONTRACT } from "@003/shared";

/** «192.168.1.20» → `http://192.168.1.20:3003` (puerto por defecto de Nodo; admite esquema y puerto escritos). */
export function normalizeServer(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`);
    // Solo se habla con un servidor por HTTP(S): nada de otros esquemas
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) return null;
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
