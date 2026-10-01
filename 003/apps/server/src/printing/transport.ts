import net from "node:net";

export interface PrinterTarget {
  host: string | null;
  port: number;
}

/** Medio de envío a la impresora. Inyectable para poder probar sin hardware. */
export interface PrinterTransport {
  send(target: PrinterTarget, data: Buffer): Promise<void>;
  /** true si la impresora acepta conexión. */
  ping(target: PrinterTarget): Promise<boolean>;
}

const TIMEOUT_MS = 3000;

function connect(target: PrinterTarget): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    if (!target.host) return reject(new Error("Impresora sin IP configurada"));
    const socket = net.createConnection({ host: target.host, port: target.port });
    socket.setTimeout(TIMEOUT_MS);
    socket.once("connect", () => resolve(socket));
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`Tiempo de espera agotado (${target.host}:${target.port})`));
    });
    socket.once("error", (e) => reject(e));
  });
}

/** Envío directo por TCP (puerto 9100, protocolo RAW) a impresoras LAN/WiFi. */
export const tcpTransport: PrinterTransport = {
  async send(target, data) {
    const socket = await connect(target);
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.end(data, () => resolve());
    });
  },
  async ping(target) {
    try {
      (await connect(target)).destroy();
      return true;
    } catch {
      return false;
    }
  },
};
