import net from "node:net";
import { networkInterfaces } from "node:os";

/** Redes /24 a las que está conectado este equipo (`192.168.1`, …), sin la de retorno ni las de enlace local. */
export function localSubnets(): string[] {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal || i.address.startsWith("169.254.")) continue;
      out.add(i.address.split(".").slice(0, 3).join("."));
    }
  }
  return [...out];
}

/** Las 254 direcciones de una red /24 (`192.168.1` → `192.168.1.1` … `.254`). */
export const hostsOfSubnet = (subnet: string) =>
  Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);

const isOpen = (host: string, port: number, timeoutMs: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.createConnection({ host, port });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs);
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
  });

export interface ScanResult {
  host: string;
  port: number;
}

/**
 * Busca equipos que aceptan conexión en `port` (las impresoras térmicas de red escuchan en 9100). Prueba como máximo
 * `concurrency` direcciones a la vez y descarta las que no responden en `timeoutMs`.
 */
export async function scanPort(
  hosts: string[],
  port = 9100,
  opts: { timeoutMs?: number; concurrency?: number } = {},
): Promise<ScanResult[]> {
  const timeoutMs = opts.timeoutMs ?? 400;
  const concurrency = Math.max(1, opts.concurrency ?? 64);
  const found: ScanResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const host = hosts[next++]!;
      if (await isOpen(host, port, timeoutMs)) found.push({ host, port });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return found.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}
