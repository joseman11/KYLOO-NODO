import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { openDb, type Db } from "../src/db";
import { Hub } from "../src/hub";
import { processQueue } from "../src/printing/queue";
import type { PrinterTarget, PrinterTransport } from "../src/printing/transport";
import { seed } from "../src/seed";

class FakeTransport implements PrinterTransport {
  sent: { host: string | null; text: string }[] = [];
  down = new Set<string>();
  async send(t: PrinterTarget, data: Buffer) {
    if (t.host && this.down.has(t.host)) throw new Error("ECONNREFUSED");
    this.sent.push({ host: t.host, text: data.toString("latin1") });
  }
  async ping(t: PrinterTarget) {
    return !(t.host && this.down.has(t.host));
  }
}

let app: FastifyInstance;
let db: Db;
let transport: FakeTransport;
let hub: Hub;
const H = (token: string) => ({ Authorization: `Bearer ${token}` });
let n = 0;
const key = () => `key-${++n}-${Math.random().toString(36).slice(2)}`;

async function pin(name: string, p: string) {
  const users = (await app.inject({ method: "GET", url: "/api/auth/users" })).json() as { id: string; name: string }[];
  const u = users.find((x) => x.name === name)!;
  const r = await app.inject({ method: "POST", url: "/api/auth/pin", payload: { userId: u.id, pin: p } });
  return { token: r.json().token as string, id: u.id };
}
async function admin() {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin1234" } });
  return r.json().token as string;
}
const products = async (t: string) => (await app.inject({ method: "GET", url: "/api/products", headers: H(t) })).json() as { id: string; name: string }[];
const tables = async (t: string) => (await app.inject({ method: "GET", url: "/api/tables", headers: H(t) })).json() as { id: string; number: string }[];

async function openTable(token: string, number = "1") {
  const t = (await tables(token)).find((x) => x.number === number)!;
  const r = await app.inject({ method: "POST", url: `/api/tables/${t.id}/open`, headers: H(token), payload: { guests: 2 } });
  return { tableId: t.id, res: r, accountId: r.json().id as string };
}

beforeEach(() => {
  db = openDb(":memory:");
  seed(db, "admin1234");
  transport = new FakeTransport();
  hub = new Hub();
  app = buildApp(db, { transport, hub });
});

describe("mesas y comandas", () => {
  it("una mesa ocupada no se puede abrir de nuevo (RN-001 / concurrencia)", async () => {
    const juan = await pin("Juan", "1111");
    const pedro = await pin("Pedro", "2222");
    expect((await openTable(juan.token)).res.statusCode).toBe(201);
    expect((await openTable(pedro.token)).res.statusCode).toBe(409);
  });

  it("una comanda con cocina y bar se divide en 3 tickets y 3 impresiones (sec. 12)", async () => {
    const adm = await admin();
    const juan = await pin("Juan", "1111");
    const { accountId } = await openTable(juan.token);
    const prods = await products(adm);
    const items = ["Hamburguesa clásica", "Ensalada", "Margarita"].map((name) => ({
      productId: prods.find((p) => p.name === name)!.id, quantity: name === "Margarita" ? 2 : 1,
    }));
    const r = await app.inject({ method: "POST", url: `/api/accounts/${accountId}/orders`, headers: H(juan.token), payload: { items, clientId: "cliente-0001" } });
    expect(r.statusCode).toBe(201);
    expect(db.prepare("SELECT COUNT(*) c FROM production_tickets").get()).toEqual({ c: 3 });

    await processQueue(db, transport, hub);
    expect(transport.sent.map((s) => s.host).sort()).toEqual(["192.168.1.50", "192.168.1.51", "192.168.1.52"]);

    // reenviar con el mismo clientId no duplica (idempotencia)
    const dup = await app.inject({ method: "POST", url: `/api/accounts/${accountId}/orders`, headers: H(juan.token), payload: { items, clientId: "cliente-0001" } });
    expect(dup.json().duplicate).toBe(true);
    expect(db.prepare("SELECT COUNT(*) c FROM orders").get()).toEqual({ c: 1 });
  });

  it("la adición imprime solo lo nuevo (sec. 15)", async () => {
    const adm = await admin();
    const juan = await pin("Juan", "1111");
    const { accountId } = await openTable(juan.token);
    const prods = await products(adm);
    const send = (name: string) =>
      app.inject({ method: "POST", url: `/api/accounts/${accountId}/orders`, headers: H(juan.token), payload: { items: [{ productId: prods.find((p) => p.name === name)!.id }] } });
    await send("Hamburguesa clásica");
    await processQueue(db, transport, hub);
    transport.sent.length = 0;
    const add = await send("Margarita");
    expect(add.json().isAddition).toBe(true);
    await processQueue(db, transport, hub);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.text).toContain("ADICION");
    expect(transport.sent[0]!.text).not.toContain("Hamburguesa");
  });

  it("un producto agotado no se puede vender", async () => {
    const adm = await admin();
    const juan = await pin("Juan", "1111");
    const { accountId } = await openTable(juan.token);
    const p = (await products(adm)).find((x) => x.name === "Ensalada")!;
    await app.inject({ method: "POST", url: `/api/products/${p.id}/availability`, headers: H(adm), payload: { availability: "agotado" } });
    const r = await app.inject({ method: "POST", url: `/api/accounts/${accountId}/orders`, headers: H(juan.token), payload: { items: [{ productId: p.id }] } });
    expect(r.statusCode).toBe(409);
  });

  it("cancelar después de producción exige autorización de gerente (RN-005)", async () => {
    const adm = await admin();
    const juan = await pin("Juan", "1111");
    const { accountId } = await openTable(juan.token);
    const prods = await products(adm);
    const o = await app.inject({ method: "POST", url: `/api/accounts/${accountId}/orders`, headers: H(juan.token), payload: { items: [{ productId: prods[0]!.id }] } });
    expect(o.statusCode).toBe(201);
    const acct = (await app.inject({ method: "GET", url: `/api/accounts/${accountId}`, headers: H(juan.token) })).json();
    const item = acct.items[0];
    const ticket = db.prepare("SELECT id FROM production_tickets").get() as { id: string };

    // antes de producción: libre, con motivo
    const early = await app.inject({ method: "POST", url: `/api/items/${item.id}/cancel`, headers: H(juan.token), payload: { reason: "Error de captura" } });
    expect(early.json().afterProduction).toBe(false);

    // nuevo ítem, la cocina lo recibe → cancelar requiere autorización
    await app.inject({ method: "POST", url: `/api/accounts/${accountId}/orders`, headers: H(juan.token), payload: { items: [{ productId: prods[0]!.id }] } });
    const t2 = db.prepare("SELECT id FROM production_tickets WHERE status='pendiente' AND id!=?").get(ticket.id) as { id: string };
    const chef = await (async () => {
      await app.inject({ method: "POST", url: "/api/users", headers: H(adm), payload: { name: "Chef", role: "cocina", pin: "4444" } });
      return pin("Chef", "4444");
    })();
    await app.inject({ method: "POST", url: `/api/tickets/${t2.id}/status`, headers: H(chef.token), payload: { status: "preparando" } });
    const item2 = (await app.inject({ method: "GET", url: `/api/accounts/${accountId}`, headers: H(juan.token) })).json().items.find((i: { status: string }) => i.status === "activo");
    const denied = await app.inject({ method: "POST", url: `/api/items/${item2.id}/cancel`, headers: H(juan.token), payload: { reason: "Cliente canceló" } });
    expect(denied.statusCode).toBe(403);

    await app.inject({ method: "POST", url: "/api/users", headers: H(adm), payload: { name: "Gerente", role: "gerente", pin: "5555" } });
    const g = await pin("Gerente", "5555");
    const ok = await app.inject({ method: "POST", url: `/api/items/${item2.id}/cancel`, headers: H(juan.token), payload: { reason: "Cliente canceló", authorizerId: g.id, authorizerPin: "5555" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().afterProduction).toBe(true);
  });

  it("transfiere, cambia, divide y fusiona cuentas", async () => {
    const adm = await admin();
    const juan = await pin("Juan", "1111");
    const pedro = await pin("Pedro", "2222");
    const a = await openTable(juan.token, "1");
    const prods = await products(adm);
    await app.inject({ method: "POST", url: `/api/accounts/${a.accountId}/orders`, headers: H(juan.token), payload: { items: [{ productId: prods[0]!.id }, { productId: prods[1]!.id }] } });

    expect((await app.inject({ method: "POST", url: `/api/accounts/${a.accountId}/transfer`, headers: H(juan.token), payload: { waiterId: pedro.id } })).statusCode).toBe(200);
    const t5 = (await tables(adm)).find((t) => t.number === "5")!;
    expect((await app.inject({ method: "POST", url: `/api/accounts/${a.accountId}/move`, headers: H(juan.token), payload: { tableId: t5.id } })).statusCode).toBe(200);
    const floor = (await app.inject({ method: "GET", url: "/api/floor", headers: H(juan.token) })).json() as { number: string; status: string }[];
    expect(floor.find((t) => t.number === "1")!.status).toBe("disponible");
    expect(floor.find((t) => t.number === "5")!.status).toBe("ocupada");

    const acct = (await app.inject({ method: "GET", url: `/api/accounts/${a.accountId}`, headers: H(juan.token) })).json();
    const split = await app.inject({ method: "POST", url: `/api/accounts/${a.accountId}/split`, headers: H(juan.token), payload: { itemIds: [acct.items[1].id] } });
    expect(split.statusCode).toBe(201);
    const merge = await app.inject({ method: "POST", url: `/api/accounts/${a.accountId}/merge`, headers: H(juan.token), payload: { sourceAccountId: split.json().id } });
    expect(merge.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/accounts/${a.accountId}`, headers: H(juan.token) })).json().items).toHaveLength(2);
  });
});

describe("impresión", () => {
  it("impresora principal caída → reintenta y pasa a la secundaria sin perder la comanda (RN-012)", async () => {
    const adm = await admin();
    const juan = await pin("Juan", "1111");
    // secundaria para la estación de calientes
    const [st] = db.prepare("SELECT id FROM stations WHERE name='Plancha'").all() as { id: string }[];
    const sec = db.prepare("SELECT id FROM printers WHERE name='Caja'").get() as { id: string };
    db.prepare("UPDATE stations SET secondary_printer_id=? WHERE id=?").run(sec.id, st!.id);
    transport.down.add("192.168.1.50");

    const { accountId } = await openTable(juan.token);
    const burger = (await products(adm)).find((p) => p.name === "Hamburguesa clásica")!;
    await app.inject({ method: "POST", url: `/api/accounts/${accountId}/orders`, headers: H(juan.token), payload: { items: [{ productId: burger.id }] } });

    let now = Date.now();
    for (let i = 0; i < 6; i++) {
      await processQueue(db, transport, hub, now);
      now += 60_000;
    }
    expect(transport.sent.map((s) => s.host)).toEqual(["192.168.1.53"]);
    expect(db.prepare("SELECT status FROM print_jobs").get()).toEqual({ status: "impreso" });
  });

  it("sin secundaria, el trabajo queda en error y se puede reintentar", async () => {
    const adm = await admin();
    const juan = await pin("Juan", "1111");
    transport.down.add("192.168.1.52");
    const { accountId } = await openTable(juan.token);
    const marg = (await products(adm)).find((p) => p.name === "Margarita")!;
    await app.inject({ method: "POST", url: `/api/accounts/${accountId}/orders`, headers: H(juan.token), payload: { items: [{ productId: marg.id }] } });
    const errors: unknown[] = [];
    hub.subscribe((e) => e.type === "print.error" && errors.push(e));
    let now = Date.now();
    for (let i = 0; i < 8; i++) {
      await processQueue(db, transport, hub, now);
      now += 60_000;
    }
    const job = db.prepare("SELECT id, status FROM print_jobs").get() as { id: string; status: string };
    expect(job.status).toBe("error");
    expect(errors).toHaveLength(1);

    transport.down.clear();
    expect((await app.inject({ method: "POST", url: `/api/print-jobs/${job.id}/retry`, headers: H(adm), payload: {} })).statusCode).toBe(200);
    await processQueue(db, transport, hub);
    expect(db.prepare("SELECT status FROM print_jobs").get()).toEqual({ status: "impreso" });
  });

  it("imprimir prueba responde con el resultado", async () => {
    const adm = await admin();
    const printers = (await app.inject({ method: "GET", url: "/api/printers", headers: H(adm) })).json() as { id: string; host: string }[];
    const r = await app.inject({ method: "POST", url: `/api/printers/${printers[0]!.id}/test`, headers: H(adm) });
    expect(r.json().ok).toBe(true);
  });
});

describe("caja y cobro", () => {
  async function ready() {
    const adm = await admin();
    const juan = await pin("Juan", "1111");
    const caja = await pin("Caja", "3333");
    const { accountId } = await openTable(juan.token);
    const prods = await products(adm);
    await app.inject({
      method: "POST", url: `/api/accounts/${accountId}/orders`, headers: H(juan.token),
      payload: { items: [{ productId: prods.find((p) => p.name === "Hamburguesa clásica")!.id }, { productId: prods.find((p) => p.name === "Margarita")!.id, quantity: 2 }] },
    });
    return { adm, juan, caja, accountId }; // total 14900 + 2*8900 = 32700
  }

  it("no se puede cobrar con la caja cerrada", async () => {
    const { caja, accountId } = await ready();
    const r = await app.inject({ method: "POST", url: `/api/accounts/${accountId}/payments`, headers: H(caja.token), payload: { idempotencyKey: key(), lines: [{ method: "efectivo", amount_cents: 32700 }] } });
    expect(r.statusCode).toBe(409);
  });

  it("pago mixto idempotente: cobra una sola vez y libera la mesa", async () => {
    const { caja, accountId, juan } = await ready();
    await app.inject({ method: "POST", url: "/api/cash/open", headers: H(caja.token), payload: { opening_cents: 200000 } });
    const k = key();
    const payload = { idempotencyKey: k, lines: [{ method: "efectivo", amount_cents: 10000 }, { method: "tarjeta", amount_cents: 22700, reference: "AUT123" }], tip_cents: 3000, tip_method: "tarjeta" };
    const r1 = await app.inject({ method: "POST", url: `/api/accounts/${accountId}/payments`, headers: H(caja.token), payload });
    expect(r1.statusCode).toBe(201);
    const r2 = await app.inject({ method: "POST", url: `/api/accounts/${accountId}/payments`, headers: H(caja.token), payload });
    expect(r2.json().duplicate).toBe(true);
    expect(db.prepare("SELECT COUNT(*) c FROM payments").get()).toEqual({ c: 1 });
    const floor = (await app.inject({ method: "GET", url: "/api/floor", headers: H(juan.token) })).json() as { number: string; status: string }[];
    expect(floor.find((t) => t.number === "1")!.status).toBe("disponible");
    // cuenta cerrada no admite más comandas (RN-009)
    const prods = await products(await admin());
    const late = await app.inject({ method: "POST", url: `/api/accounts/${accountId}/orders`, headers: H(juan.token), payload: { items: [{ productId: prods[0]!.id }] } });
    expect(late.statusCode).toBe(409);
  });

  it("cambio en efectivo, corte con diferencia exige motivo (RN-008)", async () => {
    const { caja, accountId } = await ready();
    await app.inject({ method: "POST", url: "/api/cash/open", headers: H(caja.token), payload: { opening_cents: 200000 } });
    const pay = await app.inject({ method: "POST", url: `/api/accounts/${accountId}/payments`, headers: H(caja.token), payload: { idempotencyKey: key(), lines: [{ method: "efectivo", amount_cents: 40000 }] } });
    expect(pay.json().change_cents).toBe(40000 - 32700);

    const w = await app.inject({ method: "POST", url: "/api/cash/movements", headers: H(caja.token), payload: { kind: "retiro", amount_cents: 10000, reason: "Pago proveedor" } });
    expect(w.statusCode).toBe(403); // el cajero necesita autorización
    const adm = await admin();
    const mgr = db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string };
    db.prepare("UPDATE users SET pin_hash=(SELECT pin_hash FROM users WHERE name='Caja') WHERE id=?").run(mgr.id); // PIN 3333 para el admin de prueba
    const w2 = await app.inject({ method: "POST", url: "/api/cash/movements", headers: H(caja.token), payload: { kind: "retiro", amount_cents: 10000, reason: "Pago proveedor", authorizerId: mgr.id, authorizerPin: "3333" } });
    expect(w2.statusCode).toBe(201);

    const cur = (await app.inject({ method: "GET", url: "/api/cash/current", headers: H(caja.token) })).json();
    expect(cur.summary.expected_cash_cents).toBe(200000 + 32700 - 10000);

    const noReason = await app.inject({ method: "POST", url: "/api/cash/close", headers: H(caja.token), payload: { counted_cents: cur.summary.expected_cash_cents - 20000 } });
    expect(noReason.statusCode).toBe(400);
    const close = await app.inject({ method: "POST", url: "/api/cash/close", headers: H(caja.token), payload: { counted_cents: cur.summary.expected_cash_cents - 20000, reason: "Billete faltante" } });
    expect(close.json().difference_cents).toBe(-20000);
    void adm;
  });

  it("reportes y dashboard reflejan la venta", async () => {
    const { caja, accountId, adm } = await ready();
    await app.inject({ method: "POST", url: "/api/cash/open", headers: H(caja.token), payload: { opening_cents: 0 } });
    await app.inject({ method: "POST", url: `/api/accounts/${accountId}/payments`, headers: H(caja.token), payload: { idempotencyKey: key(), lines: [{ method: "tarjeta", amount_cents: 32700 }] } });
    const rep = (await app.inject({ method: "GET", url: "/api/reports/sales", headers: H(adm) })).json();
    expect(rep.sales_cents).toBe(32700);
    expect(rep.by_product.find((p: { product: string }) => p.product === "Margarita").units).toBe(2);
    expect(rep.by_waiter[0].waiter).toBe("Juan");
    const dash = (await app.inject({ method: "GET", url: "/api/dashboard", headers: H(adm) })).json();
    expect(dash.sales_today_cents).toBe(32700);
    const csv = await app.inject({ method: "GET", url: "/api/reports/sales?format=csv&section=by_product", headers: H(adm) });
    expect(csv.body).toContain("Margarita");
  });
});

describe("tiempo real", () => {
  it("los eventos llegan al hub al abrir mesa", async () => {
    const events: string[] = [];
    hub.subscribe((e) => events.push(e.type));
    const juan = await pin("Juan", "1111");
    await openTable(juan.token);
    expect(events).toContain("table.updated");
  });
});
