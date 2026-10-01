import { useEffect, useRef, useState } from "react";

export interface SessionUser {
  id: string;
  name: string;
  role: string;
  photo?: string | null;
  permissions: string[];
}

const KEY = "003.session";
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
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

/** Error de red (servidor inalcanzable): distinto de un rechazo del servidor. */
export class NetworkError extends Error {}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body ? "POST" : "GET"),
      // Sin cuerpo no se declara JSON: el servidor rechaza un DELETE con content-type JSON y cuerpo vacío
      headers: { ...(opts.body ? { "content-type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
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
export function useLive<T>(load: () => Promise<T>, types: string[], deps: unknown[] = [], cacheKey?: string) {
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
    const fn: Listener = (e) => (types.includes(e.type) || e.type === "connection.restored") && run();
    listeners.add(fn);
    return () => {
      alive = false;
      listeners.delete(fn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, reload: () => loadRef.current().then(setData) };
}

export function onEvent(fn: Listener) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

// ---------- Operaciones sin conexión (offline avanzado) ----------
// Lo que se hace sin red se guarda con un id y se envía por lotes a /api/sync al reconectar.
// El servidor devuelve un resultado por operación (ok, duplicada, conflicto, error): reenviar nunca duplica.
const QUEUE_KEY = "003.pending-ops";
export type PendingOp =
  | { id: string; type: "order"; accountId: string; items: unknown[] }
  | { id: string; type: "request_bill"; accountId: string };

const readQueue = (): PendingOp[] => {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");
  } catch {
    return [];
  }
};
const writeQueue = (q: PendingOp[]) => {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  } catch {
    /* ignorar */
  }
};

export const pendingCount = () => readQueue().length;

/** Ejecuta una operación en línea; si no hay red la guarda para sincronizar después. */
async function run(op: PendingOp, online: () => Promise<unknown>): Promise<{ queued: boolean }> {
  try {
    await online();
    return { queued: false };
  } catch (e) {
    if (!(e instanceof NetworkError)) throw e;
    writeQueue([...readQueue(), op]);
    return { queued: true };
  }
}

export function sendOrder(accountId: string, items: unknown[]) {
  const id = crypto.randomUUID();
  return run({ id, type: "order", accountId, items }, () => api(`/api/accounts/${accountId}/orders`, { body: { clientId: id, items } }));
}

export function requestBillOffline(accountId: string) {
  const id = crypto.randomUUID();
  return run({ id, type: "request_bill", accountId }, () => api(`/api/accounts/${accountId}/request-bill`, { method: "POST", body: {} }));
}

export interface SyncConflict { type: string; code?: string; message?: string; status: string; }

/** Envía el lote pendiente. Devuelve cuántas se aplicaron y las que hubo que rechazar (p. ej. producto agotado). */
export async function flushPending(): Promise<{ sent: number; conflicts: SyncConflict[] }> {
  const ops = readQueue();
  if (ops.length === 0) return { sent: 0, conflicts: [] };
  try {
    const { results } = await api<{ results: { id: string; status: string; code?: string; message?: string }[] }>("/api/sync", { body: { ops } });
    const conflicts: SyncConflict[] = [];
    let sent = 0;
    for (const r of results) {
      if (r.status === "ok" || r.status === "duplicate") sent++;
      else conflicts.push({ type: ops.find((o) => o.id === r.id)?.type ?? "?", ...r });
    }
    writeQueue([]); // todas tuvieron resultado definitivo
    return { sent, conflicts };
  } catch (e) {
    if (e instanceof NetworkError) return { sent: 0, conflicts: [] }; // seguimos sin red
    throw e;
  }
}

export const money = (cents: number) => (cents / 100).toLocaleString("es-MX", { style: "currency", currency: "MXN" });

/** Dirección de la foto de un platillo (o null si no tiene). */
export const photoSrc = (file?: string | null) => (file ? `/api/photos/${file}` : null);
