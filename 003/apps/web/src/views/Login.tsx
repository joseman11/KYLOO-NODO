import { useEffect, useState } from "react";
import {
  api,
  isNativeApp,
  serverBase,
  setServerBase,
  setSession,
  useLive,
  type SessionUser,
} from "../api";
import { PagedGrid } from "../fit";
import { KylooLogo, NodoLogo, NodoMark } from "../Logo";
import { ROLE_LABEL as ROLE, UserAvatar } from "../Avatar";
import { WaveCanvas } from "../WaveCanvas";
import { Setup } from "./Setup";

export function Login({ onLogin }: { onLogin: (u: SessionUser) => void }) {
  const { data: users, error: loadError } = useLive(
    () =>
      api<{ id: string; name: string; role: string; photo: string | null }[]>("/api/auth/users"),
    [],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [admin, setAdmin] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const info = useLive(() => api<{ name: string | null }>("/api/auth/info"), []);
  const setup = useLive(
    () => api<{ needsSetup: boolean; local: boolean }>("/api/setup/status"),
    [],
  );
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(t);
  }, []);
  const [error, setError] = useState<string | null>(null);

  const finish = (r: { token: string; user: SessionUser }) => {
    setSession(r.token, r.user);
    onLogin(r.user);
  };
  const fail = (e: unknown) => {
    const code = (e as { code?: string }).code;
    setError(
      code === "bloqueado_temporalmente"
        ? "Demasiados intentos. Espera un minuto."
        : code === "credenciales_invalidas"
          ? "PIN o contraseña incorrectos"
          : (e as Error).message,
    );
    setPin("");
  };
  const press = (d: string) => {
    setPin((p) => (p + d).slice(0, 8));
    setError(null);
  };
  const submitPin = () =>
    api("/api/auth/pin", { body: { userId: selected, pin } }).then(finish, fail);

  const hour = now.getHours();
  const greeting = hour < 12 ? "Buenos días" : hour < 20 ? "Buenas tardes" : "Buenas noches";
  const date = now.toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });
  const time = now.toLocaleTimeString("es-MX", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const list = (users ?? []).filter((u) => u.role !== "admin");
  // Instalación nueva: no hay usuarios, se crea el administrador
  if (setup.data?.needsSetup) return <Setup onLogin={onLogin} local={setup.data.local} />;
  const chosen = list.find((u) => u.id === selected) ?? null;

  return (
    <div className="login-wrap">
      <div className="login-hero">
        <div aria-hidden="true" style={{ display: "contents" }}>
          <WaveCanvas />
        </div>
        <a
          className="by-kyloo"
          href="https://kyloo.com.mx/"
          target="_blank"
          rel="noreferrer"
          aria-label="Hecho por Kyloo"
        >
          <span>by</span>
          <KylooLogo width={74} />
        </a>
        <div className="mark" aria-hidden="true">
          <NodoLogo size="clamp(220px, 32vw, 440px)" color="#f4f2ec" />
        </div>
      </div>
      <div className="login">
        <div className="login-top">
          <div className="row" style={{ gap: 10, minWidth: 0 }}>
            <NodoMark size={36} />
            <strong className="ellipsis">{info.data?.name ?? "Nodo"}</strong>
          </div>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              setAdmin(!admin);
              setSelected(null);
              setError(null);
            }}
          >
            {admin ? "Entrar con PIN" : "Administración"}
          </button>
          {isNativeApp() && (
            <button
              type="button"
              className="btn ghost sm"
              title={serverBase()}
              onClick={() => {
                setServerBase(null);
                location.reload();
              }}
            >
              Cambiar servidor
            </button>
          )}
        </div>

        <div className="login-hello">
          <div className="login-time num">{time}</div>
          <div>
            <h2>
              {admin
                ? "Acceso administración"
                : chosen
                  ? `Hola, ${chosen.name.split(" ")[0]}`
                  : greeting}
            </h2>
            <p className="small">{date.charAt(0).toUpperCase() + date.slice(1)}</p>
          </div>
        </div>
        {loadError && <p className="err">No se puede conectar con el servidor: {loadError}</p>}

        {admin ? (
          <form
            className="col"
            onSubmit={(e) => {
              e.preventDefault();
              api("/api/auth/login", { body: { username, password } }).then(finish, fail);
            }}
          >
            <input
              placeholder="Usuario"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoCapitalize="none"
            />
            <input
              placeholder="Contraseña"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button className="btn primary" type="submit">
              Entrar
            </button>
          </form>
        ) : !chosen ? (
          <>
            <div className="small login-label">¿Quién eres? Toca tu nombre</div>
            <div className="users fill">
              <PagedGrid
                items={list}
                minW={190}
                minH={64}
                gap={10}
                render={(u) => (
                  <button
                    type="button"
                    className="user-card"
                    onClick={() => {
                      setSelected(u.id);
                      setPin("");
                      setError(null);
                    }}
                  >
                    <UserAvatar name={u.name} photo={u.photo} size={48} />
                    <span className="who">
                      <strong className="ellipsis">{u.name}</strong>
                      <span className="small">{ROLE[u.role] ?? u.role}</span>
                    </span>
                  </button>
                )}
              />
            </div>
          </>
        ) : (
          <div className="login-pin fill">
            <div className="row" style={{ gap: 12, flex: "none" }}>
              <UserAvatar name={chosen.name} photo={chosen.photo} size={56} active />
              <div className="grow">
                <strong>{chosen.name}</strong>
                <div className="small">{ROLE[chosen.role] ?? chosen.role} · escribe tu PIN</div>
              </div>
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  setSelected(null);
                  setPin("");
                  setError(null);
                }}
              >
                Cambiar
              </button>
            </div>
            <div className="pin-dots">
              {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
                <span key={i} className={i < pin.length ? "on" : ""} />
              ))}
            </div>
            <div className="pad">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                <button type="button" key={d} className="btn" onClick={() => press(d)}>
                  {d}
                </button>
              ))}
              <button type="button" className="btn" onClick={() => setPin(pin.slice(0, -1))}>
                ⌫
              </button>
              <button type="button" className="btn" onClick={() => press("0")}>
                0
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={pin.length < 4}
                onClick={submitPin}
              >
                Entrar
              </button>
            </div>
          </div>
        )}
        {error && <p className="err">{error}</p>}
        <div className="login-foot small">
          <span className="dot-ok" />
          Conectado al servidor del local
        </div>
      </div>
    </div>
  );
}
