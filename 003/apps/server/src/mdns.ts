import { networkInterfaces } from "node:os";
import { Bonjour } from "bonjour-service";

/** Direcciones IPv4 de este equipo en la red local (sin la de retorno ni las de enlace local). */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254."))
        out.push(i.address);
    }
  }
  return out;
}

export interface MdnsHandle {
  /** Nombre `.local` anunciado (p. ej. `nodo.local`). */
  host: string;
  stop: () => void;
}

/**
 * Anuncia el servidor en la red local (mDNS/Bonjour) como `nodo.local` y como servicio HTTP «Nodo», para que las tablets
 * lo encuentren sin teclear la IP. Es una comodidad: en algunas redes y sistemas (p. ej. versiones antiguas de Android) el
 * nombre `.local` no se resuelve, por eso la pantalla de conexión muestra también la IP y su código QR.
 * Nunca lanza: sin red o sin permisos simplemente no anuncia.
 */
export function startMdns(
  port: number,
  onError: (e: unknown) => void = () => undefined,
  host = "nodo.local",
): MdnsHandle | null {
  try {
    const bonjour = new Bonjour(undefined, onError);
    bonjour.publish({ name: "Nodo", type: "http", port, host, txt: { app: "nodo" } });
    return {
      host,
      stop: () => {
        try {
          bonjour.unpublishAll(() => bonjour.destroy());
        } catch {
          /* ya detenido */
        }
      },
    };
  } catch (e) {
    onError(e);
    return null;
  }
}
