import { useEffect, useRef, useState } from "react";
import { backdrop } from "../sheet";
import { decodeQr } from "../qr";
import { normalizeServer, probeServer } from "../server-address";
import { setServerBase } from "../api";
import { KylooLogo, NodoLogo, NodoMark } from "../Logo";
import { WaveCanvas } from "../WaveCanvas";

/**
 * Cámara que busca el código QR de *Configuración → Conectar*. Cada ~150 ms se lee un cuadro y se prueba con el lector;
 * al encontrar una dirección, la entrega y se detiene. La cámara se libera siempre al cerrar.
 */
function QrScanner({ onFound, onClose }: { onFound: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let alive = true;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (!alive) return stream.getTracks().forEach((t) => t.stop());
        const v = video.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play();
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        timer = setInterval(() => {
          if (!ctx || v.videoWidth === 0) return;
          canvas.width = v.videoWidth;
          canvas.height = v.videoHeight;
          ctx.drawImage(v, 0, 0);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const text = decodeQr(img.data, img.width, img.height);
          if (text) onFound(text);
        }, 150);
      } catch {
        setError("No se pudo usar la cámara. Revisa el permiso de la app o escribe la dirección.");
      }
    })();
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onFound]);
  return (
    <div className="sheet-bg" {...backdrop(onClose)}>
      <div className="sheet center" role="dialog" aria-modal="true">
        <h3>Escanea el código QR</h3>
        <p className="small">Apunta a la pantalla del servidor: Configuración → Conectar.</p>
        {error ? (
          <p className="err">{error}</p>
        ) : (
          // biome-ignore lint/a11y/useMediaCaption: es la vista de la cámara, sin audio
          <video
            ref={video}
            playsInline
            muted
            style={{ width: "100%", maxHeight: 320, borderRadius: 12, background: "#000" }}
          />
        )}
        <button type="button" className="btn" onClick={onClose}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

/**
 * Pantalla de conexión de la app envoltorio: la primera vez (o al cambiar de servidor) se indica dónde está el servidor
 * del local. La dirección se ve en el servidor, en Configuración → Conectar.
 */
export function ServerSetup({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);

  const connect = async (text = value) => {
    setError(null);
    const base = normalizeServer(text);
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
          {typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && (
            <button type="button" className="btn" onClick={() => setScanning(true)} disabled={busy}>
              Escanear código QR
            </button>
          )}
        </form>
      </div>
      {scanning && (
        <QrScanner
          onClose={() => setScanning(false)}
          onFound={(text) => {
            setScanning(false);
            setValue(text);
            void connect(text);
          }}
        />
      )}
    </div>
  );
}
