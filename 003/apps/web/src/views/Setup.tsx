import { useState } from "react";
import { type SessionUser, api, setSession } from "../api";
import { KylooLogo, NodoLogo, NodoMark } from "../Logo";
import { WaveCanvas } from "../WaveCanvas";

/**
 * Primer arranque de una instalación nueva: se crea el administrador y se nombra el local.
 * No hay usuarios ni claves de fábrica; esta pantalla solo existe mientras no haya ningún usuario.
 */
export function Setup({
  onLogin,
  local = true,
}: {
  onLogin: (u: SessionUser) => void;
  /** Este dispositivo es el propio equipo del servidor: solo desde ahí se crea al administrador. */
  local?: boolean;
}) {
  const [establishment, setEstablishment] = useState("");
  const [adminName, setAdminName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (password.length < 8) return setError("La contraseña debe tener al menos 8 caracteres");
    if (password !== repeat) return setError("Las contraseñas no coinciden");
    setBusy(true);
    try {
      await api("/api/setup", { body: { establishment, adminName, username, password } });
      const r = await api<{ token: string; user: SessionUser }>("/api/auth/login", {
        body: { username, password },
      });
      setSession(r.token, r.user);
      onLogin(r.user);
    } catch (e) {
      const issues = (e as { issues?: { message?: string }[] }).issues;
      setError(issues?.[0]?.message ?? (e as Error).message);
      setBusy(false);
    }
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
            <h2>Bienvenido a Nodo</h2>
            <p className="small">
              Configura tu local. Estos datos se pueden cambiar después en Configuración.
            </p>
          </div>
        </div>
        {!local ? (
          <p className="err">
            Nodo todavía no está configurado. Abre esta misma dirección desde el propio equipo donde
            se instaló (en su navegador, <strong>http://localhost:3003</strong>) para crear al
            administrador. Por seguridad no se puede hacer desde otro dispositivo.
          </p>
        ) : (
          <form
            className="col"
            data-setup
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <input
              placeholder="Nombre del local"
              value={establishment}
              onChange={(e) => setEstablishment(e.target.value)}
              autoFocus
              required
            />
            <input
              placeholder="Tu nombre"
              value={adminName}
              onChange={(e) => setAdminName(e.target.value)}
              required
            />
            <input
              placeholder="Usuario de administrador"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              required
            />
            <input
              placeholder="Contraseña (mínimo 8 caracteres)"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
            <input
              placeholder="Repite la contraseña"
              type="password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              autoComplete="new-password"
              required
            />
            {error && <p className="err">{error}</p>}
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? "Creando…" : "Crear y entrar"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
