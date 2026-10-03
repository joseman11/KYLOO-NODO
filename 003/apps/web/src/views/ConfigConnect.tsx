import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { api, can, useLive } from "../api";

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

interface StandbyStatus {
  paired: boolean;
  last_seen: number | null;
  url: string | null;
}

/** Servidor de reserva: otra PC del local que copia a este equipo y puede tomar su lugar si se descompone. */
export function Standby() {
  const status = useLive(() => api<StandbyStatus>("/api/standby/status"), []);
  const net = useLive(() => api<Network>("/api/network"), []);
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!can("user.manage")) return null;
  const s = status.data;
  const addr = net.data?.addresses[0]
    ? `http://${net.data.addresses[0]}:${net.data.port}`
    : "http://<IP de este equipo>:3003";
  const mins = s?.last_seen ? Math.round((Date.now() - s.last_seen) / 60000) : null;

  const show = async (rotate = false) => {
    setErr(null);
    try {
      const r = await api<{ key: string }>("/api/standby/pairing", { body: { password, rotate } });
      setKey(r.key);
      setPassword("");
      setAsking(false);
      status.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <section className="card fillcard">
      <h3>Servidor de reserva</h3>
      <p className="small">
        Una segunda PC con Nodo copia a este equipo cada pocos minutos. Si este equipo se
        descompone, la reserva se convierte en el servidor en un minuto y las tablets se pasan
        solas.
      </p>
      {!s?.paired ? (
        <p className="small">Sin reserva emparejada.</p>
      ) : mins === null ? (
        <p className="small">Emparejada, pero la reserva todavía no ha copiado nada.</p>
      ) : (
        <p className={mins > 20 ? "err" : "small"}>
          Última copia de la reserva ({s.url}): hace {mins} min
          {mins > 20 ? ". Revisa que esa PC esté encendida y en la red." : "."}
        </p>
      )}
      {key && (
        <div className="card" role="status">
          <p className="small">
            En la PC de reserva, instala Nodo y ejecuta (una sola vez), luego reinicia el servicio:
          </p>
          <code className="num" style={{ wordBreak: "break-all" }}>
            node server.mjs standby --of {addr} --key {key}
          </code>
        </div>
      )}
      {asking ? (
        <form
          className="row"
          style={{ gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            void show();
          }}
        >
          <input
            type="password"
            placeholder="Tu contraseña"
            aria-label="Tu contraseña"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="submit" className="btn primary" disabled={!password}>
            Mostrar
          </button>
          <button type="button" className="btn ghost" onClick={() => setAsking(false)}>
            Cancelar
          </button>
        </form>
      ) : (
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn" onClick={() => setAsking(true)}>
            {s?.paired ? "Ver clave de emparejamiento" : "Emparejar una reserva"}
          </button>
          {s?.paired && (
            <button
              type="button"
              className="btn ghost"
              onClick={() =>
                api("/api/standby/pairing", { method: "DELETE" }).then(() => status.reload())
              }
            >
              Quitar reserva
            </button>
          )}
        </div>
      )}
      {err && <p className="err">{err}</p>}
    </section>
  );
}
