import { useEffect, useState } from "react";
import {
  OFFLINE_PREFIX,
  api,
  can,
  flushPending,
  getUser,
  isNativeApp,
  isOfflineId,
  onEvent,
  pendingCount,
  prefetchReference,
  serverBase,
  setSession,
  startRealtime,
  stopRealtime,
  useLive,
  useOnline,
  type SessionUser,
} from "./api";
import { learnServers, useFailover } from "./failover";
import { Icon } from "./icons";
import { NodoMark } from "./Logo";
import { ROLE_LABEL, UserAvatar } from "./Avatar";
import { LicenseNotice } from "./views/LicenseNotice";
import { Login } from "./views/Login";
import { ServerSetup } from "./views/ServerSetup";
import { Floor } from "./views/Floor";
import { Order } from "./views/Order";
import { Station } from "./views/Station";
import { Cash } from "./views/Cash";
import { Admin } from "./views/Admin";
import { Config } from "./views/Config";
import { RecipeBook } from "./views/RecipeBook";
import { SharedShopping } from "./views/SharedShopping";
import { External } from "./views/External";
import { Reservations } from "./views/Reservations";
import { Inventory } from "./views/Inventory";
import { PublicMenu } from "./views/PublicMenu";
import { Analytics } from "./views/Analytics";
import { Pass } from "./views/Pass";
import { Hq } from "./views/Hq";

type Tab =
  | "mesas"
  | "pase"
  | "pedidos"
  | "reservas"
  | "estacion"
  | "caja"
  | "inventario"
  | "recetas"
  | "analitica"
  | "admin"
  | "config";
interface Toast {
  id: number;
  text: string;
  alert?: boolean;
}

export function App() {
  // El menú QR de la mesa es público: no requiere sesión
  if (location.pathname === "/m") return <PublicMenu />;
  // Consola de la nube (organizaciones): también sin sesión de sucursal
  if (location.pathname === "/hq") return <Hq />;
  // Lista de compras compartida por enlace: pública, sin sesión
  if (location.pathname === "/s") return <SharedShopping />;
  // App envoltorio sin servidor elegido: primero se conecta
  if (isNativeApp() && !serverBase()) return <ServerSetup onDone={() => location.reload()} />;
  return <Staff />;
}

const fmtSince = (ts: number) => {
  const m = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};

function Staff() {
  const [user, setUser] = useState<SessionUser | null>(getUser());
  const [tab, setTab] = useState<Tab>("mesas");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [pending, setPending] = useState(pendingCount());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const online = useOnline();
  const failover = useFailover(!!user && isNativeApp(), online);

  useEffect(() => {
    if (!user) return;
    startRealtime();
    void prefetchReference(); // el menú queda en el dispositivo por si se cae la red
    if (isNativeApp()) void learnServers(); // y a dónde irse si el servidor se cae (servidor de reserva)
    return () => stopRealtime();
  }, [user]);

  // Avisos en tiempo real: mesero llamado, stock bajo, errores de impresión, diferencias de caja
  useEffect(() => {
    if (!user) return;
    const push = (text: string, alert = false) => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t.slice(-3), { id, text, alert }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 8000);
    };
    return onEvent(async (e) => {
      if (e.type === "connection.restored") {
        void prefetchReference();
        if (pendingCount()) {
          const { sent, conflicts, mapped, failedRefs } = await flushPending();
          if (sent) push(`${sent} operación(es) sin conexión sincronizadas`);
          for (const c of conflicts)
            push(
              c.type === "open_table"
                ? `No se pudo abrir la mesa${c.table ? ` ${c.table}` : ""} que abriste sin conexión: ${c.message ?? c.code ?? "conflicto"}`
                : `No se pudo aplicar ${c.type === "order" ? "una comanda" : "una operación"}: ${c.message ?? c.code ?? "conflicto"}`,
              true,
            );
          // Si se estaba viendo una mesa abierta sin conexión: pasa a la cuenta real, o vuelve al mapa si no pudo abrirse
          setAccountId((cur) => {
            if (!cur || !isOfflineId(cur)) return cur;
            const ref = cur.slice(OFFLINE_PREFIX.length);
            return mapped[ref] ?? (failedRefs.includes(ref) ? null : cur);
          });
        }
        setPending(pendingCount());
      } else if (e.type === "waiter.called" && can("order.create")) {
        push(
          `Mesa ${e.tableNumber} ${e.reason === "cuenta" ? "pide la cuenta" : "llama al mesero"}`,
          true,
        );
      } else if (e.type === "inventory.alert" && can("inventory.view")) {
        push(`Inventario ${e.level}: ${e.name}`, e.level !== "bajo");
      } else if (e.type === "print.error" && (can("printer.manage") || can("comanda.reprint"))) {
        push(`Error de impresión: ${e.message}`, true);
      } else if (e.type === "cash.difference" && can("reports.view")) {
        push("Diferencia en el corte de caja", true);
      }
    });
  }, [user]);

  useEffect(() => {
    const t = setInterval(() => setPending(pendingCount()), 2000);
    return () => clearInterval(t);
  }, []);

  // Platos listos para entregar: insignia en el módulo "Pase"
  const ready = useLive(
    () => (user ? api<unknown[]>("/api/ready") : Promise.resolve(null)),
    ["ticket.updated", "order.created"],
    [user?.id ?? ""],
  );
  // Checador
  const clock = useLive(
    () =>
      user
        ? api<{ on_shift: boolean; since: number | null }>("/api/clock/status")
        : Promise.resolve(null),
    ["staff.updated"],
    [user?.id ?? ""],
  );
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  if (!user)
    return (
      <Login
        onLogin={(u) => {
          setUser(u);
          setTab(defaultTab(u));
        }}
      />
    );

  const logout = () => {
    api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setSession(null, null);
    setUser(null);
    setAccountId(null);
  };

  const toggleClock = () =>
    api(clock.data?.on_shift ? "/api/clock/out" : "/api/clock/in", {
      method: "POST",
      body: {},
    }).then(
      () => clock.reload(),
      () => clock.reload(),
    );

  const tabs: { id: Tab; label: string; icon: string; show: boolean; badge?: number }[] = [
    { id: "mesas", label: "Mesas", icon: "mesas", show: can("order.create") },
    {
      id: "pase",
      label: "Pase",
      icon: "pase",
      show: can("order.create") || can("item.mark_ready") || can("item.mark_delivered"),
      badge: ready.data?.length,
    },
    { id: "pedidos", label: "Llevar", icon: "llevar", show: can("order.create") },
    { id: "reservas", label: "Reservas", icon: "reservas", show: can("reservation.manage") },
    {
      id: "estacion",
      label: "Cocina",
      icon: "cocina",
      show: can("station.update") || can("item.mark_ready"),
    },
    { id: "caja", label: "Caja", icon: "caja", show: can("payment.take") || can("cash.open") },
    { id: "inventario", label: "Inventario", icon: "inventario", show: can("inventory.view") },
    { id: "recetas", label: "Recetas", icon: "recetas", show: true },
    { id: "analitica", label: "Analítica", icon: "analitica", show: can("reports.view") },
    {
      id: "admin",
      label: "Admin",
      icon: "admin",
      show: can("reports.view") || can("printer.manage"),
    },
    {
      id: "config",
      label: "Config",
      icon: "config",
      show: can("venue.manage") || can("product.create"),
    },
  ];
  const current = tabs.find((t) => t.id === tab);

  return (
    <div className="shell">
      {/* Menú de módulos (lateral) */}
      <nav className="rail" aria-label="Módulos">
        <div className="rail-brand">
          <NodoMark size={42} />
        </div>
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button
              type="button"
              key={t.id}
              className={`rail-btn ${tab === t.id ? "active" : ""}`}
              onClick={() => {
                setTab(t.id);
                setAccountId(null);
              }}
            >
              <Icon name={t.icon} size={24} />
              <span>{t.label}</span>
              {t.badge ? <span className="rail-badge">{t.badge}</span> : null}
            </button>
          ))}
      </nav>

      <div className="workspace">
        <div className="status-bar">
          <strong>{current?.label}</strong>
          <span className={`pill ${online ? "ok" : "off"}`}>
            <span className="dot" />
            {online ? "Conectado" : "Sin conexión"}
          </span>
          <span className="grow" />
          <button
            type="button"
            className={`clock-btn ${clock.data?.on_shift ? "on" : ""}`}
            onClick={toggleClock}
            title="Checador de entrada y salida"
          >
            <Icon name="reloj" size={16} />{" "}
            {clock.data?.on_shift
              ? `En turno · ${fmtSince(clock.data.since ?? Date.now())} · Salida`
              : "Registrar entrada"}
          </button>
          <div className="user-chip">
            <UserAvatar name={user.name} photo={user.photo} size={34} />
            <div className="who2">
              {user.name}
              <small>{ROLE_LABEL[user.role] ?? user.role}</small>
            </div>
          </div>
          <button type="button" className="btn ghost sm" onClick={logout}>
            Salir
          </button>
        </div>
        <LicenseNotice />
        {!online && failover.searching && (
          <div className="banner" role="alert">
            {failover.standbyUrl ? (
              <span>
                El servidor principal no responde. Hay un servidor de reserva en{" "}
                {failover.standbyUrl}: ábrelo en el navegador y pulsa «Promover a principal».
              </span>
            ) : (
              <span>
                El servidor principal no responde: buscando el servidor de reserva. Mientras tanto,
                las comandas se guardan en este dispositivo.
              </span>
            )}
          </div>
        )}
        {pending > 0 && (
          <div className="banner">
            {pending} operación(es) guardada(s) sin enviar — se enviarán al reconectar
          </div>
        )}
        <main className="main">
          {accountId ? (
            <Order accountId={accountId} onBack={() => setAccountId(null)} />
          ) : (
            <>
              {tab === "mesas" && <Floor onOpen={setAccountId} />}
              {tab === "pase" && <Pass />}
              {tab === "pedidos" && <External onOpen={setAccountId} />}
              {tab === "reservas" && (
                <Reservations
                  onSeat={(id) => {
                    setTab("mesas");
                    setAccountId(id);
                  }}
                />
              )}
              {tab === "estacion" && <Station />}
              {tab === "caja" && <Cash />}
              {tab === "inventario" && <Inventory />}
              {tab === "recetas" && <RecipeBook />}
              {tab === "analitica" && <Analytics />}
              {tab === "admin" && <Admin />}
              {tab === "config" && <Config />}
            </>
          )}
        </main>
        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.alert ? "alert" : ""}`}>
              {t.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function defaultTab(u: SessionUser): Tab {
  const p = u.permissions;
  if (p.includes("order.create")) return "mesas";
  if (p.includes("station.update") || p.includes("item.mark_ready")) return "estacion";
  if (p.includes("payment.take") || p.includes("cash.open")) return "caja";
  if (p.includes("inventory.view")) return "inventario";
  return "admin";
}
