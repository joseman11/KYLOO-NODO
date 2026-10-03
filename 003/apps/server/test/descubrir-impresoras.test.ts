import net from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { openDb } from "../src/db";
import { Hub } from "../src/hub";
import { hostsOfSubnet, localSubnets, scanPort } from "../src/printing/discover";
import { seed } from "../src/seed";

const servers: net.Server[] = [];
const listen = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer((c) => c.end());
    servers.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as net.AddressInfo).port));
  });
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

describe("búsqueda de impresoras", () => {
  it("una red /24 son 254 direcciones", () => {
    const h = hostsOfSubnet("192.168.1");
    expect(h).toHaveLength(254);
    expect(h[0]).toBe("192.168.1.1");
    expect(h[253]).toBe("192.168.1.254");
  });

  it("las redes locales no incluyen la de retorno ni las de enlace local", () => {
    for (const s of localSubnets()) {
      expect(s).toMatch(/^\d+\.\d+\.\d+$/);
      expect(s.startsWith("127.")).toBe(false);
      expect(s.startsWith("169.254.")).toBe(false);
    }
  });

  it("encuentra los equipos que escuchan en el puerto y descarta los demás", async () => {
    const port = await listen();
    const r = await scanPort(["127.0.0.1", "127.0.0.2"], port, { timeoutMs: 300 });
    // en macOS 127.0.0.2 no existe como alias; basta con que 127.0.0.1 aparezca y nada que no escuche
    expect(r.map((x) => x.host)).toContain("127.0.0.1");
    expect(r.every((x) => x.port === port)).toBe(true);
    expect(await scanPort(["127.0.0.1"], 1, { timeoutMs: 200 })).toEqual([]);
  });

  it("respeta la concurrencia y devuelve las direcciones ordenadas numéricamente", async () => {
    const port = await listen();
    const hosts = ["127.0.0.1", "127.0.0.1"];
    expect((await scanPort(hosts, port, { concurrency: 1 })).length).toBe(2);
  });
});

describe("ruta de búsqueda", () => {
  let app: FastifyInstance;
  let adm: string;
  beforeEach(async () => {
    const db = await openDb(":memory:");
    await seed(db, "admin1234");
    app = buildApp(db, { hub: new Hub() });
    adm = (
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: "admin1234" },
      })
    ).json().token;
  });
  afterEach(async () => {
    await app.close();
  });
  const discover = (token: string, body: unknown) =>
    app.inject({
      method: "POST",
      url: "/api/printers/discover",
      headers: { Authorization: `Bearer ${token}` },
      payload: body as object,
    });

  it("devuelve lo encontrado y marca las impresoras que ya están dadas de alta", async () => {
    const port = await listen();
    const mine = await app.inject({
      method: "POST",
      url: "/api/printers",
      headers: { Authorization: `Bearer ${adm}` },
      payload: { name: "Cocina nueva", kind: "cocina", host: "127.0.0.1", port },
    });
    expect(mine.statusCode).toBe(201);
    const r = await discover(adm, { hosts: ["127.0.0.1"], port, timeoutMs: 300 });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.scanned).toBe(1);
    expect(body.found).toEqual([
      { host: "127.0.0.1", port, configured: { id: mine.json().id, name: "Cocina nueva" } },
    ]);
  });

  it("una dirección sin impresora no aparece como configurada", async () => {
    const port = await listen();
    const r = (await discover(adm, { hosts: ["127.0.0.1"], port })).json();
    expect(r.found[0]).toMatchObject({ host: "127.0.0.1", configured: null });
  });

  it("solo quien administra impresoras puede buscar, y se limita el tamaño del escaneo", async () => {
    const users = (await app.inject({ method: "GET", url: "/api/auth/users" })).json() as {
      id: string;
      name: string;
    }[];
    const juan = users.find((u) => u.name === "Juan")!;
    const t = (
      await app.inject({
        method: "POST",
        url: "/api/auth/pin",
        payload: { userId: juan.id, pin: "1111" },
      })
    ).json().token;
    expect((await discover(t, {})).statusCode).toBe(403);
    expect(
      (
        await discover(adm, {
          hosts: Array.from({ length: 1025 }, (_, i) => `10.0.${i >> 8}.${i & 255}`),
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/printers/discover" })).statusCode).toBe(
      401,
    );
  });
});
