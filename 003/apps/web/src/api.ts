import { useEffect, useRef, useState } from "react";

export interface SessionUser {
  id: string;
  name: string;
  role: string;
  photo?: string | null;
  permissions: string[];
}

const KEY = "003.session";
const SERVER_KEY = "003.server";

/**
 * Servidor al que habla la interfaz. Vacío = el mismo origen que la sirve (la web normal). En la app envoltorio de las
 * tablets la interfaz va dentro de la app y el servidor del local se elige en la pantalla de conexión.
 */
export function serverBase(): string {
  try {
    return localStorage.getItem(SERVER_KEY) ?? "";
  } catch {
    return "";
  }
}
export function setServerBase(url: string | null) {
  try {
    if (url) localStorage.setItem(SERVER_KEY, url);
    else localStorage.removeItem(SERVER_KEY);
  } catch {
    /* sin almacenamiento disponible */
  }
}
/** ¿Corre dentro de la app envoltorio (Capacitor)? */
export const isNativeApp = () =>
  typeof window !== "undefined" &&
  !!(
    window as { Capacitor?: { isNativePlatform?: () => boolean } }
  ).Capacitor?.isNativePlatform?.();
/** URL absoluta de una ruta de la API (o la ruta tal cual si la interfaz y el servidor son el mismo origen). */
export const serverUrl = (path: string) => `${serverBase()}${path}`;
let token: string | null = null;
let user: SessionUser | null = null;

try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
  if (saved) ({ token, user } = saved);
} catch {
  /* sin almacenamiento disponible */
}

export const getUser = () => user;
export const can = (perm: string) => !!user?.permissions.includes(perm);

export function setSession(t: string | null, u: SessionUser | null) {
  token = t;
  user = u;
  try {
    if (t) localStorage.setItem(KEY, JSON.stringify({ token: t, user: u }));
    else localStorage.removeItem(KEY);
  } catch {
    /* ignorar */
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** Error de red (servidor inalcanzable): distinto de un rechazo del servidor. */
export class NetworkError extends Error {}

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  // Una mesa abierta sin conexión aún no existe en el servidor: lo que no es pedir o pedir la cuenta espera a reconectar
  if (path.includes(`/accounts/${OFFLINE_PREFIX}`))
    throw new ApiError(
      409,
      "mesa_sin_sincronizar",
      "Esta mesa se abrió sin conexión: esa función estará disponible al reconectar",
    );
  let res: Response;
  try {
    res = await fetch(serverUrl(path), {
      method: opts.method ?? (opts.body ? "POST" : "GET"),
      // Sin cuerpo no se declara JSON: el servidor rechaza un DELETE con content-type JSON y cuerpo vacío
      headers: {
        ...(opts.body ? { "content-type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new NetworkError("Sin conexión con el servidor");
  }
  if (res.status === 401 && token && !path.startsWith("/api/auth")) {
    setSession(null, null);
    location.reload();
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? "error", data?.message);
  return data as T;
}

// ---------- Tiempo real (WebSocket con reconexión automática) ----------
type Listener = (e: { type: string; [k: string]: unknown }) => void;
const listeners = new Set<Listener>();
const statusListeners = new Set<(online: boolean) => void>();
let socket: WebSocket | null = null;
let online = false;
let retry = 0;
let wanted = false;

function setOnline(v: boolean) {
  if (online === v) return;
  online = v;
  statusListeners.forEach((fn) => fn(v));
}

function open() {
  if (!wanted || !token) return;
  const target = new URL(serverBase() || location.origin);
  const proto = target.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${target.host}/ws?token=${encodeURIComponent(token)}`);
  socket.onopen = () => {
    retry = 0;
    setOnline(true);
    listeners.forEach((fn) => fn({ type: "connection.restored" }));
  };
  socket.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data);
      listeners.forEach((fn) => fn(e));
    } catch {
      /* ignorar */
    }
  };
  socket.onclose = () => {
    setOnline(false);
    if (wanted) setTimeout(open, Math.min(10_000, 500 * 2 ** retry++));
  };
}

export function startRealtime() {
  wanted = true;
  if (!socket || socket.readyState > 1) open();
}
export function stopRealtime() {
  wanted = false;
  socket?.close();
}

export function useOnline(): boolean {
  const [v, setV] = useState(online);
  useEffect(() => {
    statusListeners.add(setV);
    return () => void statusListeners.delete(setV);
  }, []);
  return v;
}

/** Ejecuta `load` al montar y cada vez que llega un evento de los tipos indicados. */
export function useLive<T>(
  load: () => Promise<T>,
  types: string[],
  deps: unknown[] = [],
  cacheKey?: string,
) {
  // Con cacheKey, la última respuesta se guarda en el dispositivo: sin red se sigue viendo lo último conocido
  const [data, setDataRaw] = useState<T | null>(() => {
    if (!cacheKey) return null;
    try {
      return JSON.parse(localStorage.getItem(`003.cache.${cacheKey}`) ?? "null") as T | null;
    } catch {
      return null;
    }
  });
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const setData = (d: T) => {
    setDataRaw(d);
    if (cacheKey) {
      try {
        localStorage.setItem(`003.cache.${cacheKey}`, JSON.stringify(d));
      } catch {
        /* ignorar */
      }
    }
  };

  useEffect(() => {
    let alive = true;
    const run = () =>
      loadRef.current().then(
        (d) => alive && (setData(d), setError(null)),
        (e) => alive && setError(e instanceof Error ? e.message : String(e)),
      );
    run();
    const fn: Listener = (e) =>
      (types.includes(e.type) || e.type === "connection.restored") && run();
    listeners.add(fn);
    return () => {
      alive = false;
      listeners.delete(fn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // `reload` lo llaman botones y efectos sin atender el error: sin red no debe convertirse en una promesa rechazada sin atender
  return { data, error, reload: () => loadRef.current().then(setData, () => undefined) };
}

export function onEvent(fn: Listener) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

// ---------- Operaciones sin conexión (offline avanzado) ----------
// Lo que se hace sin red se guarda con un id y se envía por lotes a /api/sync al reconectar.
// El servidor devuelve un resultado por operación (ok, duplicada, conflicto, error): reenviar nunca duplica.
// Abrir una mesa sin red crea una «cuenta sombra» local (`offline:<id>`): la comanda se arma y se guarda contra ella, y al
// reconectar se abre la mesa de verdad y las comandas se aplican a la cuenta real (el servidor las enlaza por `accountRef`).
const QUEUE_KEY = "003.pending-ops";
const SHADOW_KEY = "003.offline-accounts";
const MAP_KEY = "003.offline-map";
export const OFFLINE_PREFIX = "offline:";
export const isOfflineId = (id: string) => id.startsWith(OFFLINE_PREFIX);

/** Lo que se muestra de una línea enviada sin conexión (solo para la pantalla; el servidor calcula lo real). */
export interface QueuedItemView {
  name: string;
  quantity: number;
  unit_price_cents: number;
  modifiers: string[];
  note: string | null;
  course: string | null;
  seat: number | null;
  held: number;
}
export type PendingOp =
  | { id: string; type: "open_table"; tableId: string; guests: number }
  | {
      id: string;
      type: "order";
      accountId?: string;
      accountRef?: string;
      items: unknown[];
      view?: QueuedItemView[];
    }
  | { id: string; type: "request_bill"; accountId?: string; accountRef?: string };

/** Mesa abierta sin conexión que todavía no existe en el servidor. */
export interface Shadow {
  ref: string;
  tableId: string;
  tableNumber: string;
  waiter: string;
  waiterId: string;
  guests: number;
  openedAt: number;
}

const readJson = <T>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "") as T;
  } catch {
    return fallback;
  }
};
const writeJson = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* sin almacenamiento disponible */
  }
};
const readQueue = (): PendingOp[] => readJson<PendingOp[]>(QUEUE_KEY, []);
const writeQueue = (q: PendingOp[]) => {
  writeJson(QUEUE_KEY, q);
  emitLocal({ type: "offline.changed" });
};
const readShadows = () => readJson<Shadow[]>(SHADOW_KEY, []);
const readMap = () => readJson<Record<string, string>>(MAP_KEY, {});

/** Avisa a las pantallas de que cambió lo pendiente (para que repinten sin pedir nada al servidor). */
export function emitLocal(e: { type: string; [k: string]: unknown }) {
  listeners.forEach((fn) => fn(e));
}

/** Se incrementa cada vez que cambia la cola o las cuentas sin conexión: hace que una pantalla se repinte. */
export function useOfflineTick() {
  const [n, setN] = useState(0);
  useEffect(() => onEvent((e) => e.type === "offline.changed" && setN((x) => x + 1)), []);
  return n;
}

export const pendingCount = () => readQueue().length;

/** La cuenta sombra de un id `offline:…` mientras la mesa no se haya abierto en el servidor. */
export const shadowFor = (accountId: string) =>
  readShadows().find((x) => `${OFFLINE_PREFIX}${x.ref}` === accountId) ?? null;
/** Mesas abiertas sin conexión pendientes de sincronizar. */
export const pendingOpens = () => readShadows().filter((x) => !readMap()[x.ref]);
/** Comandas guardadas sin conexión que aún no llegan al servidor, para mostrarlas en su cuenta. */
export function queuedItemsFor(accountId: string): QueuedItemView[] {
  const ref = isOfflineId(accountId) ? accountId.slice(OFFLINE_PREFIX.length) : null;
  const real = ref ? readMap()[ref] : accountId;
  return readQueue().flatMap((o) =>
    o.type === "order" && ((ref && o.accountRef === ref) || (real && o.accountId === real))
      ? (o.view ?? [])
      : [],
  );
}

/** A qué cuenta del servidor se refiere un id (real, sombra ya abierta en el servidor, o sombra pendiente). */
function target(accountId: string): { accountId?: string; accountRef?: string } {
  if (!isOfflineId(accountId)) return { accountId };
  const ref = accountId.slice(OFFLINE_PREFIX.length);
  const real = readMap()[ref];
  return real ? { accountId: real } : { accountRef: ref };
}
/** Id con el que la pantalla debe seguir hablando de la cuenta (la real, si la sombra ya se abrió). */
export const resolveAccountId = (accountId: string) =>
  isOfflineId(accountId)
    ? (readMap()[accountId.slice(OFFLINE_PREFIX.length)] ?? accountId)
    : accountId;

/**
 * Ejecuta una operación en línea; si no hay red la guarda para sincronizar después. Si ya hay operaciones esperando, esta
 * va detrás de ellas (el orden importa: la mesa se abre antes que su comanda) y se intenta vaciar la cola enseguida.
 */
async function run(op: PendingOp, online: () => Promise<unknown>): Promise<{ queued: boolean }> {
  if (readQueue().length > 0) {
    writeQueue([...readQueue(), op]);
    await flushPending().catch(() => undefined);
    return { queued: readQueue().some((o) => o.id === op.id) };
  }
  try {
    await online();
    return { queued: false };
  } catch (e) {
    if (!(e instanceof NetworkError)) throw e;
    writeQueue([...readQueue(), op]);
    return { queued: true };
  }
}

/** Abre una mesa. Sin red, la abre «en sombra»: se puede pedir ya y se sincroniza al reconectar. */
export async function openTable(
  table: { id: string; number: string },
  guests: number,
): Promise<{ id: string; queued: boolean }> {
  const id = crypto.randomUUID();
  const me = getUser();
  if (readQueue().length === 0) {
    try {
      const r = await api<{ id: string }>(`/api/tables/${table.id}/open`, {
        body: { guests, clientId: id },
      });
      return { id: r.id, queued: false };
    } catch (e) {
      if (!(e instanceof NetworkError)) throw e;
    }
  }
  const shadow: Shadow = {
    ref: id,
    tableId: table.id,
    tableNumber: table.number,
    waiter: me?.name ?? "",
    waiterId: me?.id ?? "",
    guests,
    openedAt: Date.now(),
  };
  writeJson(SHADOW_KEY, [...readShadows(), shadow]);
  writeQueue([...readQueue(), { id, type: "open_table", tableId: table.id, guests }]);
  return { id: `${OFFLINE_PREFIX}${id}`, queued: true };
}

export function sendOrder(accountId: string, items: unknown[], view?: QueuedItemView[]) {
  const id = crypto.randomUUID();
  const t = target(accountId);
  if (t.accountRef) {
    // La mesa todavía no existe en el servidor: la comanda solo puede ir a la cola
    writeQueue([...readQueue(), { id, type: "order", accountRef: t.accountRef, items, view }]);
    return Promise.resolve({ queued: true });
  }
  return run({ id, type: "order", accountId: t.accountId, items, view }, () =>
    api(`/api/accounts/${t.accountId}/orders`, { body: { clientId: id, items } }),
  );
}

export function requestBillOffline(accountId: string) {
  const id = crypto.randomUUID();
  const t = target(accountId);
  if (t.accountRef) {
    writeQueue([...readQueue(), { id, type: "request_bill", accountRef: t.accountRef }]);
    return Promise.resolve({ queued: true });
  }
  return run({ id, type: "request_bill", accountId: t.accountId }, () =>
    api(`/api/accounts/${t.accountId}/request-bill`, { method: "POST", body: {} }),
  );
}

export interface SyncConflict {
  type: string;
  code?: string;
  message?: string;
  status: string;
  /** Mesa a la que se refería (cuando se sabe). */
  table?: string;
}

/**
 * Envía el lote pendiente. Devuelve cuántas se aplicaron, las que hubo que rechazar (p. ej. producto agotado o mesa
 * ocupada por otra tablet), y para cada mesa abierta sin conexión su cuenta real (`mapped`) o que falló (`failedRefs`).
 */
export async function flushPending(): Promise<{
  sent: number;
  conflicts: SyncConflict[];
  mapped: Record<string, string>;
  failedRefs: string[];
}> {
  const ops = readQueue();
  const empty = { sent: 0, conflicts: [], mapped: {}, failedRefs: [] };
  if (ops.length === 0) return empty;
  try {
    const { results } = await api<{
      results: {
        id: string;
        status: string;
        code?: string;
        message?: string;
        data?: { id?: string };
      }[];
    }>("/api/sync", { body: { ops } });
    const conflicts: SyncConflict[] = [];
    const mapped: Record<string, string> = {};
    const failedRefs: string[] = [];
    const shadows = readShadows();
    let sent = 0;
    for (const r of results) {
      const op = ops.find((o) => o.id === r.id);
      const ok = r.status === "ok" || r.status === "duplicate";
      if (ok) sent++;
      else
        conflicts.push({
          type: op?.type ?? "?",
          table:
            op?.type === "open_table"
              ? shadows.find((x) => x.ref === op.id)?.tableNumber
              : undefined,
          ...r,
        });
      if (op?.type === "open_table") {
        if (ok && r.data?.id) mapped[op.id] = r.data.id;
        else failedRefs.push(op.id);
      }
    }
    // Resultado definitivo para todas: se vacía la cola y se actualizan las cuentas sombra
    writeJson(MAP_KEY, { ...readMap(), ...mapped });
    writeJson(
      SHADOW_KEY,
      readShadows().filter((x) => !failedRefs.includes(x.ref)),
    );
    // Solo se quitan las enviadas: pudo entrar alguna operación mientras se esperaba la respuesta
    writeQueue(readQueue().filter((o) => !ops.some((x) => x.id === o.id)));
    return { sent, conflicts, mapped, failedRefs };
  } catch (e) {
    if (e instanceof NetworkError) return empty; // seguimos sin red
    throw e;
  }
}

/**
 * Datos de referencia que la tablet necesita para tomar una comanda sin red: el menú. Se piden al entrar y cada vez que
 * vuelve la conexión, para que una tablet que perdió el WiFi antes de abrir el comandero ya los tenga. Usa la misma clave de
 * caché y la misma forma que el comandero (`useLive(…, "catalog")`).
 */
export async function loadCatalog() {
  const [products, categories, groups] = await Promise.all([
    api<unknown[]>("/api/products"),
    api<unknown[]>("/api/categories"),
    api<unknown[]>("/api/modifier-groups"),
  ]);
  return { products, categories, groups };
}
export async function prefetchReference() {
  try {
    writeJson("003.cache.catalog", await loadCatalog());
    writeJson("003.cache.favorites", await api<unknown[]>("/api/favorites"));
  } catch {
    /* sin red: se conserva lo que ya hubiera */
  }
}

export const money = (cents: number) =>
  (cents / 100).toLocaleString("es-MX", { style: "currency", currency: "MXN" });

/** Dirección de la foto de un platillo (o null si no tiene). */
export const photoSrc = (file?: string | null) => (file ? serverUrl(`/api/photos/${file}`) : null);
