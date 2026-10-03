import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { openDb } from "../src/db";
import { Hub } from "../src/hub";
import { seed } from "../src/seed";
import { standbyCli } from "../src/standby-cli";
import { startStandby } from "../src/standby-app";
import { parseRecoveryKey } from "../src/backup-crypto";
import { readStandby, standbyAuthToken, standbyCipherKey } from "../src/standby";

let tmp: string;
const open: { close(): Promise<unknown> }[] = [];
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nodo-reserva-"));
});
afterEach(async () => {
  for (const o of open.splice(0)) await o.close().catch(() => undefined);
  rmSync(tmp, { recursive: true, force: true });
});

async function primary() {
  const db = await openDb(join(tmp, "principal.sqlite"));
  await seed(db, "clave-del-local-1");
  const photos = join(tmp, "principal-fotos");
  mkdirSync(photos, { recursive: true });
  writeFileSync(join(photos, "ceviche.jpg"), "foto");
  const app = buildApp(db, {
    hub: new Hub(),
    photosDir: photos,
    backupDir: join(tmp, "principal-resp"),
  });
  open.push(app);
  const token = (
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "clave-del-local-1" },
    })
  ).json().token as string;
  const call = (method: "GET" | "POST" | "DELETE", url: string, body?: unknown) =>
    app.inject({
      method,
      url,
      headers: { Authorization: `Bearer ${token}` },
      payload: body as object,
    });
  return { app, db, call };
}

/** `fetch` que habla con la app del principal sin red (la reserva cree que es HTTP). */
const via = (app: FastifyInstance): typeof fetch =>
  (async (url: string, init?: { headers?: Record<string, string> }) => {
    const path = new URL(url).pathname;
    const r = await app.inject({ method: "GET", url: path, headers: init?.headers });
    return new Response(r.rawPayload, {
      status: r.statusCode,
      headers: { "content-type": String(r.headers["content-type"]) },
    });
  }) as never;
const down: typeof fetch = (async () => {
  throw new Error("ECONNREFUSED");
}) as never;

async function standby(
  p: Awaited<ReturnType<typeof primary>>,
  key: string,
  f: typeof fetch = via(p.app),
) {
  const dataDir = join(tmp, "reserva-datos");
  const s = await startStandby({
    dataDir,
    dbFile: join(dataDir, "nodo.sqlite"),
    photosDir: join(dataDir, "photos"),
    dir: join(dataDir, "reserva"),
    state: { primary: "http://principal:3003", key },
    port: -1,
    host: "127.0.0.1",
    version: "test",
    intervalMs: 0,
    fetch: f,
  });
  open.push({ close: () => s.stop() });
  return { s, dataDir };
}

const pair = async (p: Awaited<ReturnType<typeof primary>>) =>
  (await p.call("POST", "/api/standby/pairing", { password: "clave-del-local-1" })).json()
    .key as string;

describe("servidor de reserva: emparejamiento", () => {
  it("la clave se muestra solo con la contraseña y es estable hasta que se rota", async () => {
    const p = await primary();
    expect((await p.call("POST", "/api/standby/pairing", { password: "mala" })).statusCode).toBe(
      401,
    );
    const k1 = await pair(p);
    expect(parseRecoveryKey(k1)).not.toBeNull();
    expect(await pair(p)).toBe(k1);
    const rot = (
      await p.call("POST", "/api/standby/pairing", { password: "clave-del-local-1", rotate: true })
    ).json().key;
    expect(rot).not.toBe(k1);
    expect((await p.call("GET", "/api/standby/status")).json()).toMatchObject({
      paired: true,
      last_seen: null,
    });
  });

  it("sin emparejar o con un token ajeno no se descarga nada", async () => {
    const p = await primary();
    expect((await p.app.inject({ method: "GET", url: "/api/standby/snapshot" })).statusCode).toBe(
      401,
    );
    const k = await pair(p);
    const bad = standbyAuthToken(
      parseRecoveryKey("AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA") ??
        Buffer.alloc(32, 7),
    );
    expect(
      (
        await p.app.inject({
          method: "GET",
          url: "/api/standby/snapshot",
          headers: { authorization: `Bearer ${bad}` },
        })
      ).statusCode,
    ).toBe(401);
    const good = standbyAuthToken(parseRecoveryKey(k) as Buffer);
    const r = await p.app.inject({
      method: "GET",
      url: "/api/standby/snapshot",
      headers: { authorization: `Bearer ${good}`, "x-standby-port": "3010" },
    });
    expect(r.statusCode).toBe(200);
    // la copia va cifrada: ni rastro legible de la base
    expect(r.rawPayload.includes(Buffer.from("SQLite format 3"))).toBe(false);
    // y el principal ya sabe dónde está la reserva (para avisarlo a las tablets)
    expect((await p.call("GET", "/api/standby/peers")).json()).toEqual({
      standby_url: "http://127.0.0.1:3010",
    });
    // retirar el emparejamiento corta la descarga
    await p.call("DELETE", "/api/standby/pairing");
    expect(
      (
        await p.app.inject({
          method: "GET",
          url: "/api/standby/snapshot",
          headers: { authorization: `Bearer ${good}` },
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe("servidor de reserva: copia y promoción", () => {
  it("copia al principal, y al caer este se promueve con todos sus datos", async () => {
    const p = await primary();
    const key = await pair(p);
    const before = (await p.call("GET", "/api/tables")).json().length;
    const { s, dataDir } = await standby(p, key);
    await s.tick();
    expect(s.status.last_error).toBeNull();
    expect(s.status.last_sync).not.toBeNull();

    // el principal sigue vivo → no se promueve sin confirmar
    const alive = await s.app.inject({
      method: "POST",
      url: "/api/standby/promote",
      payload: { key },
    });
    expect(alive.statusCode).toBe(409);
    expect(alive.json().error).toBe("principal_activo");
    // clave equivocada
    expect(
      (
        await s.app.inject({
          method: "POST",
          url: "/api/standby/promote",
          payload: { key: "no-es-la-clave" },
        })
      ).statusCode,
    ).toBe(401);

    // se cae el principal: la reserva lo detecta y se deja promover
    const dead = await standby(p, key, down);
    const health = (await dead.s.app.inject({ method: "GET", url: "/api/health" })).json();
    expect(health.role).toBe("standby");
    expect(health.standby.primary_up).toBe(false);

    // (misma carpeta que la reserva que sí copió)
    const r = await s.app.inject({
      method: "POST",
      url: "/api/standby/promote",
      payload: { key, force: true },
    });
    expect(r.statusCode).toBe(200);
    await s.promoted;
    expect(readStandby(dataDir)?.promoted).toBe(true);

    // la base promovida abre y trae lo del principal, fotos incluidas
    const db = await openDb(join(dataDir, "nodo.sqlite"));
    open.push(db);
    const app = buildApp(db, { hub: new Hub() });
    open.push(app);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "clave-del-local-1" },
    });
    expect(login.statusCode).toBe(200);
    const tables = await app.inject({
      method: "GET",
      url: "/api/tables",
      headers: { Authorization: `Bearer ${login.json().token}` },
    });
    expect(tables.json().length).toBe(before);
    expect(readFileSync(join(dataDir, "photos", "ceviche.jpg"), "utf8")).toBe("foto");
    expect((await app.inject({ method: "GET", url: "/api/health" })).json().role).toBe("primary");
  });

  it("sin copia previa no se puede promover", async () => {
    const p = await primary();
    const key = await pair(p);
    const { s } = await standby(p, key, down);
    await s.tick();
    expect(s.status.last_error).toBeTruthy();
    const r = await s.app.inject({
      method: "POST",
      url: "/api/standby/promote",
      payload: { key, force: true },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("sin_copia");
  });

  it("una descarga dañada no pisa la última copia buena", async () => {
    const p = await primary();
    const key = await pair(p);
    const { s, dataDir } = await standby(p, key);
    await s.tick();
    const good = readFileSync(join(dataDir, "reserva", "estado.json"), "utf8");
    // el siguiente intento recibe basura cifrada a medias
    const trunc: typeof fetch = (async (
      url: string,
      init?: { headers?: Record<string, string> },
    ) => {
      const r = await p.app.inject({
        method: "GET",
        url: new URL(url).pathname,
        headers: init?.headers,
      });
      return new Response(r.rawPayload.subarray(0, Math.floor(r.rawPayload.length / 2)), {
        status: 200,
      });
    }) as never;
    const s2 = await startStandby({
      dataDir,
      dbFile: join(dataDir, "nodo.sqlite"),
      photosDir: join(dataDir, "photos"),
      dir: join(dataDir, "reserva"),
      state: { primary: "http://principal:3003", key },
      port: -1,
      host: "127.0.0.1",
      version: "t",
      intervalMs: 0,
      fetch: trunc,
    });
    open.push({ close: () => s2.stop() });
    await s2.tick();
    expect(s2.status.last_error).toBeTruthy();
    expect(readFileSync(join(dataDir, "reserva", "estado.json"), "utf8")).toBe(good);
    expect(existsSync(join(dataDir, "reserva", "lista", "db.sqlite"))).toBe(true);
    expect(readdirSync(join(dataDir, "reserva")).sort()).toEqual(["estado.json", "lista"]);
  });

  it("la cifra de la copia depende de la clave: otra clave no la abre", () => {
    const a = standbyCipherKey(Buffer.alloc(32, 1));
    const b = standbyCipherKey(Buffer.alloc(32, 2));
    expect(a.equals(b)).toBe(false);
    expect(standbyCipherKey(Buffer.alloc(32, 1)).equals(a)).toBe(true);
  });
});

describe("server.mjs standby", () => {
  it("deja el equipo como reserva, valida la clave y se puede quitar", async () => {
    const p = await primary();
    const key = await pair(p);
    const old = process.env.NODO_DATA_DIR;
    process.env.NODO_DATA_DIR = join(tmp, "cli");
    try {
      expect(standbyCli(["--of", "10.0.0.5", "--key", "xxx"])).toBe(2);
      expect(standbyCli(["--of", "10.0.0.5"])).toBe(2);
      expect(standbyCli(["--of", "10.0.0.5", "--key", key])).toBe(0);
      expect(readStandby(join(tmp, "cli"))).toEqual({ primary: "http://10.0.0.5:3003", key });
      expect(standbyCli(["--off"])).toBe(0);
      expect(readStandby(join(tmp, "cli"))).toBeNull();
    } finally {
      if (old === undefined) delete process.env.NODO_DATA_DIR;
      else process.env.NODO_DATA_DIR = old;
    }
  });
});
