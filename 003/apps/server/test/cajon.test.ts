import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { type Db, openDb } from "../src/db";
import { Hub } from "../src/hub";
import { processQueue } from "../src/printing/queue";
import { DRAWER_PIN2, DRAWER_PIN5 } from "../src/printing/markup";
import { toEscpos } from "../src/printing/escpos";
import type { PrinterTarget, PrinterTransport } from "../src/printing/transport";
import { seed } from "../src/seed";

class Capture implements PrinterTransport {
  sent: { host: string | null; data: Buffer }[] = [];
  down = new Set<string>();
  async send(t: PrinterTarget, data: Buffer) {
    if (t.host && this.down.has(t.host)) throw new Error("ECONNREFUSED");
    this.sent.push({ host: t.host, data });
  }
  async ping() {
    return true;
  }
}
const PULSE2 = Buffer.from([0x1b, 0x70, 0x00, 25, 250]);
const PULSE5 = Buffer.from([0x1b, 0x70, 0x01, 25, 250]);
const has = (b: Buffer, seq: Buffer) => b.includes(seq);

let app: FastifyInstance;
let db: Db;
let hub: Hub;
let transport: Capture;
let adm: string;
let caja: string;
let juan: string;
let tableId: string;
let cajaPrinter: string;
let n = 0;

async function login(name: string, pin: string) {
  const users = (await app.inject({ method: "GET", url: "/api/auth/users" })).json() as {
    id: string;
    name: string;
  }[];
  const u = users.find((x) => x.name === name)!;
  return (
    await app.inject({ method: "POST", url: "/api/auth/pin", payload: { userId: u.id, pin } })
  ).json().token as string;
}
const call = (t: string, method: "GET" | "POST" | "PATCH", url: string, body?: unknown) =>
  app.inject({ method, url, headers: { Authorization: `Bearer ${t}` }, payload: body as object });

beforeEach(async () => {
  db = await openDb(":memory:");
  await seed(db, "admin1234");
  transport = new Capture();
  hub = new Hub();
  app = buildApp(db, { transport, hub });
  adm = (
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "admin1234" },
    })
  ).json().token;
  caja = await login("Caja", "3333");
  juan = await login("Juan", "1111");
  tableId = ((await call(adm, "GET", "/api/tables")).json() as { id: string }[])[0]!.id;
  cajaPrinter = (
    (await call(adm, "GET", "/api/printers")).json() as { id: string; kind: string }[]
  ).find((p) => p.kind === "caja")!.id;
  await call(caja, "POST", "/api/cash/open", { opening_cents: 10000 });
});

/** Abre una mesa, pide un producto y cobra con el método indicado; devuelve lo que salió por la impresora de caja. */
async function sell(method: string) {
  const acc = (await call(juan, "POST", `/api/tables/${tableId}/open`, { guests: 2 })).json()
    .id as string;
  const prods = (await call(adm, "GET", "/api/products")).json() as {
    id: string;
    price_cents: number;
  }[];
  await call(juan, "POST", `/api/accounts/${acc}/orders`, {
    items: [{ productId: prods[0]!.id, quantity: 1 }],
  });
  const total = (
    (await call(juan, "GET", `/api/accounts/${acc}`)).json() as { total_cents: number }
  ).total_cents;
  transport.sent.length = 0;
  const r = await call(caja, "POST", `/api/accounts/${acc}/payments`, {
    idempotencyKey: `cajon-prueba-${++n}`,
    lines: [{ method, amount_cents: total }],
  });
  expect(r.statusCode).toBe(201);
  await processQueue(db, transport, hub);
  return transport.sent.filter((s) => s.host === "192.168.1.53"); // la impresora de caja del seed
}

describe("pulso ESC/POS", () => {
  it("una línea de cajón no es texto: genera solo el pulso y no avanza ni corta el papel", () => {
    expect(
      toEscpos([DRAWER_PIN2]).equals(
        Buffer.concat([Buffer.from([0x1b, 0x40, 0x1b, 0x74, 19]), PULSE2]),
      ),
    ).toBe(true);
    expect(has(toEscpos([DRAWER_PIN5]), PULSE5)).toBe(true);
  });
  it("junto a un ticket, abre el cajón primero y el ticket se imprime y corta normal", () => {
    const b = toEscpos([DRAWER_PIN2, "TOTAL $10.00"]);
    expect(b.indexOf(PULSE2)).toBeGreaterThan(0);
    expect(b.indexOf(PULSE2)).toBeLessThan(b.indexOf(Buffer.from("TOTAL")));
    expect(b.subarray(b.length - 4).equals(Buffer.from([0x1d, 0x56, 0x42, 0x00]))).toBe(true);
  });
});

describe("cajón de dinero en los cobros", () => {
  it("sin cajón configurado, ningún cobro lo abre", async () => {
    const out = await sell("efectivo");
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((s) => has(s.data, PULSE2))).toBe(false);
  });

  it("con cajón, un cobro en efectivo lo abre y el ticket sale", async () => {
    await call(adm, "PATCH", `/api/printers/${cajaPrinter}`, { has_drawer: true });
    const out = await sell("efectivo");
    expect(out.some((s) => has(s.data, PULSE2))).toBe(true);
    expect(out.some((s) => s.data.includes(Buffer.from("TOTAL")))).toBe(true);
  });

  it("con tarjeta no se abre el cajón", async () => {
    await call(adm, "PATCH", `/api/printers/${cajaPrinter}`, { has_drawer: true });
    const out = await sell("tarjeta");
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((s) => has(s.data, PULSE2) || has(s.data, PULSE5))).toBe(false);
  });

  it("respeta el pin configurado (pin 5)", async () => {
    await call(adm, "PATCH", `/api/printers/${cajaPrinter}`, { has_drawer: true, drawer_pin: 1 });
    const out = await sell("efectivo");
    expect(out.some((s) => has(s.data, PULSE5))).toBe(true);
    expect(out.some((s) => has(s.data, PULSE2))).toBe(false);
  });

  it("si la impresora no responde el cobro igual queda registrado y el cajón queda en cola", async () => {
    await call(adm, "PATCH", `/api/printers/${cajaPrinter}`, { has_drawer: true });
    transport.down.add("192.168.1.53");
    const acc = (await call(juan, "POST", `/api/tables/${tableId}/open`, { guests: 1 })).json()
      .id as string;
    const prods = (await call(adm, "GET", "/api/products")).json() as { id: string }[];
    await call(juan, "POST", `/api/accounts/${acc}/orders`, {
      items: [{ productId: prods[0]!.id, quantity: 1 }],
    });
    const total = (
      (await call(juan, "GET", `/api/accounts/${acc}`)).json() as { total_cents: number }
    ).total_cents;
    const r = await call(caja, "POST", `/api/accounts/${acc}/payments`, {
      idempotencyKey: "sin-impresora",
      lines: [{ method: "efectivo", amount_cents: total }],
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().closed).toBe(true);
    await processQueue(db, transport, hub);
    const job = (await db
      .prepare(
        "SELECT status, attempts FROM print_jobs WHERE printer_id=? AND kind='ticket' ORDER BY created_at DESC",
      )
      .get(cajaPrinter)) as { status: string; attempts: number };
    expect(job.status).toBe("pendiente"); // se reintenta; no se pierde
    expect(job.attempts).toBeGreaterThanOrEqual(1);
    // vuelve la impresora: el cajón y el ticket salen
    transport.down.clear();
    await processQueue(db, transport, hub, Date.now() + 120_000);
    expect(transport.sent.some((s) => has(s.data, PULSE2))).toBe(true);
  });
});

describe("abrir el cajón a mano", () => {
  it("abre el cajón por la cola y lo deja en la bitácora", async () => {
    await call(adm, "PATCH", `/api/printers/${cajaPrinter}`, { has_drawer: true });
    transport.sent.length = 0;
    const r = await call(caja, "POST", `/api/printers/${cajaPrinter}/open-drawer`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, status: "impreso" });
    expect(has(transport.sent[0]!.data, PULSE2)).toBe(true);
    const a = await db.prepare("SELECT action FROM audit_log WHERE action='abrir_cajon'").get();
    expect(a).toBeTruthy();
  });

  it("una impresora sin cajón responde 409 con motivo", async () => {
    const r = await call(caja, "POST", `/api/printers/${cajaPrinter}/open-drawer`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("sin_cajon");
  });

  it("un mesero no puede abrir el cajón", async () => {
    await call(adm, "PATCH", `/api/printers/${cajaPrinter}`, { has_drawer: true });
    expect((await call(juan, "POST", `/api/printers/${cajaPrinter}/open-drawer`)).statusCode).toBe(
      403,
    );
  });

  it("si la impresora no responde lo dice y el trabajo queda para reintentarse", async () => {
    await call(adm, "PATCH", `/api/printers/${cajaPrinter}`, { has_drawer: true });
    transport.down.add("192.168.1.53");
    const r = await call(caja, "POST", `/api/printers/${cajaPrinter}/open-drawer`);
    expect(r.json()).toMatchObject({ ok: false, status: "pendiente" });
    expect(r.json().error).toMatch(/ECONNREFUSED/);
  });
});
