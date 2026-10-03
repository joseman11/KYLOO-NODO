import fastifyCors from "@fastify/cors";
import Fastify from "fastify";
import { API_CONTRACT } from "@003/shared";
import { z } from "zod";
import { parseRecoveryKey } from "./backup-crypto";
import {
  type StandbyState,
  type SyncStatus,
  installCopy,
  lastGoodCopy,
  primaryAlive,
  syncOnce,
  writeStandby,
} from "./standby";

export interface StandbyOptions {
  dataDir: string;
  dbFile: string;
  photosDir: string;
  /** Carpeta de trabajo de la reserva (copia verificada). */
  dir: string;
  state: StandbyState;
  port: number;
  host: string;
  version: string;
  /** Cada cuánto copia al principal (por defecto 5 min); 0 = no copia sola (pruebas). */
  intervalMs?: number;
  fetch?: typeof fetch;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nodo — servidor de reserva</title>
<style>body{font:16px system-ui;background:#0b0b0c;color:#f4f2ec;max-width:560px;margin:8vh auto;padding:0 20px}
h1{font-size:22px}.card{background:#17171a;border-radius:16px;padding:18px;margin:14px 0}small{color:#a5a39c}
input,button{font:inherit;padding:12px;border-radius:12px;border:0;width:100%;box-sizing:border-box;margin-top:8px}
button{background:#ff5900;color:#fff;font-weight:700;cursor:pointer}.err{color:#ff8a65}</style>
<h1>Servidor de reserva</h1><div class="card" id="st">Cargando…</div>
<div class="card"><b>Convertir este equipo en el servidor principal</b><br>
<small>Hazlo solo si el servidor principal está apagado o descompuesto. Si ambos trabajan a la vez, cada uno tendrá cuentas distintas.</small>
<input id="k" placeholder="Clave de emparejamiento" autocomplete="off"><button id="go">Promover a principal</button><p id="msg"></p></div>
<script>
const $=id=>document.getElementById(id),ago=t=>t?Math.round((Date.now()-t)/60000)+' min':'nunca';
async function st(){try{const h=await (await fetch('/api/health')).json(),s=h.standby;
$('st').innerHTML='Principal: <b>'+s.primary+'</b> — '+(s.primary_up?'responde':'<span class="err">sin respuesta</span>')+
'<br>Última copia buena: <b>'+ago(s.last_sync)+'</b>'+(s.last_error?'<br><span class="err">'+s.last_error+'</span>':'')}catch(e){$('st').textContent='Sin datos'}}
$('go').onclick=async()=>{$('msg').textContent='Promoviendo…';
const r=await fetch('/api/standby/promote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:$('k').value,force:false})});
const j=await r.json();
if(r.ok){$('msg').textContent='Listo: este equipo ya es el servidor principal. Abre Nodo en esta dirección.';setTimeout(()=>location.reload(),4000)}
else if(j.error==='principal_activo'&&confirm('El principal sí responde. ¿Promover de todos modos?')){
 const r2=await fetch('/api/standby/promote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:$('k').value,force:true})});
 $('msg').textContent=r2.ok?'Listo: este equipo ya es el principal.':(await r2.json()).message}
else $('msg').innerHTML='<span class="err">'+(j.message||j.error)+'</span>'};
st();setInterval(st,5000)
</script>`;

/**
 * Modo reserva: un servidor que **no atiende comandas**; copia al principal y espera. Resuelve (con el estado final) cuando
 * se promueve: entonces `main.ts` sigue arrancando como principal sobre la base copiada.
 */
export async function startStandby(o: StandbyOptions) {
  const log = o.log ?? (() => undefined);
  const status: SyncStatus = {
    last_sync: lastGoodCopy(o.dir)?.at ?? null,
    last_error: null,
    bytes: lastGoodCopy(o.dir)?.bytes ?? null,
    primary_up: false,
  };
  const app = Fastify({ logger: false });
  await app.register(fastifyCors, { origin: true });
  const tick = async () => {
    status.primary_up = await primaryAlive(o.state.primary, o.fetch);
    const r = await syncOnce({ dir: o.dir, state: o.state, port: o.port, fetch: o.fetch });
    if (r.ok) {
      status.last_sync = Date.now();
      status.last_error = null;
      status.bytes = r.bytes;
      log("copia del principal al día", { bytes: r.bytes });
    } else {
      status.last_error = r.error;
      log("no se pudo copiar al principal", { error: r.error });
    }
  };
  // ¿Responde el principal? Se pregunta al consultar (con 3 s de memoria): la pantalla lo muestra casi en vivo
  let probedAt = 0;
  app.get("/api/health", async () => {
    if (Date.now() - probedAt > 3000) {
      probedAt = Date.now();
      status.primary_up = await primaryAlive(o.state.primary, o.fetch);
    }
    return health();
  });
  const health = () => ({
    ok: true,
    role: "standby",
    version: o.version,
    contract: API_CONTRACT,
    standby: { primary: o.state.primary, ...status },
  });
  app.get("/", async (_req, reply) => reply.type("text/html; charset=utf-8").send(PAGE));
  app.post("/api/standby/sync", async (req, reply) => {
    const { key } = z.object({ key: z.string() }).parse(req.body);
    if (!sameKey(key, o.state.key)) return reply.code(401).send({ error: "clave_invalida" });
    await tick();
    return status;
  });

  let promoted: (() => void) | null = null;
  const done = new Promise<void>((r) => (promoted = r));
  app.post("/api/standby/promote", async (req, reply) => {
    const { key, force } = z
      .object({ key: z.string(), force: z.boolean().optional() })
      .parse(req.body);
    if (!sameKey(key, o.state.key))
      return reply
        .code(401)
        .send({ error: "clave_invalida", message: "La clave de emparejamiento no coincide" });
    if (!lastGoodCopy(o.dir))
      return reply
        .code(409)
        .send({ error: "sin_copia", message: "Todavía no hay una copia del principal" });
    if (!force && (await primaryAlive(o.state.primary, o.fetch)))
      return reply.code(409).send({
        error: "principal_activo",
        message:
          "El servidor principal responde: promover dejaría dos servidores trabajando a la vez",
      });
    installCopy(o.dir, o.dbFile, o.photosDir);
    writeStandby(o.dataDir, { ...o.state, promoted: true });
    log("reserva promovida a principal");
    reply.send({ ok: true });
    setTimeout(() => promoted?.(), 200);
    return reply;
  });

  if (o.port >= 0) await app.listen({ port: o.port, host: o.host });
  const timer =
    o.intervalMs === 0
      ? null
      : setInterval(() => void tick().catch(() => undefined), o.intervalMs ?? 5 * 60_000);
  timer?.unref();
  if (o.intervalMs !== 0) void tick().catch(() => undefined);
  return {
    app,
    status,
    tick,
    promoted: done,
    stop: async () => {
      if (timer) clearInterval(timer);
      await app.close();
    },
  };
}

/** Arranca la reserva y espera hasta que la promuevan. */
export async function runStandby(o: StandbyOptions): Promise<void> {
  const s = await startStandby(o);
  await s.promoted;
  await s.stop();
}

const sameKey = (a: string, b: string) => {
  const x = parseRecoveryKey(a);
  const y = parseRecoveryKey(b);
  return !!x && !!y && x.equals(y);
};
