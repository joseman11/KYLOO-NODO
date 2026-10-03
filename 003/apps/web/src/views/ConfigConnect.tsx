import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { api, useLive } from "../api";

interface Network {
  port: number;
  mdns: string | null;
  addresses: string[];
}

/** Cómo conectar una tablet o un teléfono: se escanea el código o se escribe la dirección en el navegador. */
export function Connect() {
  const net = useLive(() => api<Network>("/api/network"), []);
  const [qr, setQr] = useState<Record<string, string>>({});
  const n = net.data;
  const urls = (n?.addresses ?? []).slice(0, 3).map((a) => `http://${a}:${n?.port}`);

  useEffect(() => {
    let alive = true;
    Promise.all(
      urls.map(async (u) => [u, await QRCode.toDataURL(u, { margin: 1, width: 220 })] as const),
    ).then((pairs) => alive && setQr(Object.fromEntries(pairs)));
    return () => {
      alive = false;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: se recalcula solo cuando cambian las direcciones
  }, [urls.join("|")]);

  return (
    <section className="card fillcard">
      <h3>Conectar tablets y teléfonos</h3>
      <p className="small">
        Deben estar conectados a la misma red (WiFi o cable) que este equipo. Escanea el código con
        la cámara o escribe la dirección en el navegador.
      </p>
      {n && urls.length === 0 && (
        <p className="err">
          Este equipo no está conectado a ninguna red local: conéctalo por cable o WiFi.
        </p>
      )}
      <div className="row wrap" style={{ alignItems: "flex-start", gap: 20 }}>
        {urls.map((u) => (
          <div key={u} className="col" style={{ alignItems: "center", gap: 6 }}>
            {qr[u] ? (
              <img src={qr[u]} alt={`Código QR de ${u}`} width={160} height={160} />
            ) : (
              <div style={{ width: 160, height: 160 }} />
            )}
            <strong className="num">{u}</strong>
          </div>
        ))}
      </div>
      {n?.mdns && (
        <p className="small">
          También puede funcionar con el nombre{" "}
          <strong>
            http://{n.mdns}:{n.port}
          </strong>{" "}
          (no todos los dispositivos lo reconocen: si no abre, usa la dirección numérica).
        </p>
      )}
      <p className="small">
        Recomendado: asigna a este equipo una <strong>IP fija</strong> en el router, para que la
        dirección no cambie.
      </p>
    </section>
  );
}
