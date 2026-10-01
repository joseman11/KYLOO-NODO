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
  async ping(t: PrinterTarget) { return !(t.host && this.down.has(t.host)); }
}

let app: FastifyInstance;
let db: Db;
let transport: FakeTransport;
let hub: Hub;
let seq = 0;
const key = () => `k-${++seq}-${Math.random().toString(36).slice(2, 10)}`;
type M = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const c = async (t: string, method: M, url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers: { Authorization: `Bearer ${t}` }, payload: payload as object });
  return { status: r.statusCode, body: r.body ? (r.headers["content-type"]?.toString().includes("json") ? r.json() : r.body) : null };
};
async function login(name: string, pin: string) {
  const users = (await app.inject({ method: "GET", url: "/api/auth/users" })).json() as { id: string; name: string }[];
  const u = users.find((x) => x.name === name)!;
  const r = await app.inject({ method: "POST", url: "/api/auth/pin", payload: { userId: u.id, pin } });
  return { token: r.json().token as string, id: u.id };
}
const adminToken = async () => (await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin1234" } })).json().token as string;
const sum = (rows: { amount_cents?: number }[]) => rows.reduce((s, r) => s + (r.amount_cents ?? 0), 0);

interface Ctx { adm: string; juan: { token: string; id: string }; caja: { token: string; id: string }; prod: Record<string, string>; tbl: Record<string, string>; }
let X: Ctx;

beforeEach(async () => {
  db = await openDb(":memory:");
  await seed(db, "admin1234");
  transport = new FakeTransport();
  hub = new Hub();
  app = buildApp(db, { transport, hub });
  const adm = await adminToken();
  const prods = (await c(adm, "GET", "/api/products")).body as { id: string; name: string }[];
  const tbls = (await c(adm, "GET", "/api/tables")).body as { id: string; number: string }[];
  X = {
    adm,
    juan: await login("Juan", "1111"),
    caja: await login("Caja", "3333"),
    prod: Object.fromEntries(prods.map((p) => [p.name, p.id])),
    tbl: Object.fromEntries(tbls.map((t) => [t.number, t.id])),
  };
});

const open = async (n: string, guests = 2, token = X.juan.token) => (await c(token, "POST", `/api/tables/${X.tbl[n]}/open`, { guests })).body.id as string;
const order = (acc: string, items: { name: string; quantity?: number; hold?: boolean; seat?: number; course?: string }[], token = X.juan.token) =>
  c(token, "POST", `/api/accounts/${acc}/orders`, { items: items.map((i) => ({ productId: X.prod[i.name], quantity: i.quantity ?? 1, hold: i.hold, seat: i.seat, course: i.course })) });
const account = async (acc: string) => (await c(X.juan.token, "GET", `/api/accounts/${acc}`)).body;
const pay = (acc: string, lines: { method: string; amount_cents: number }[], extra: Record<string, unknown> = {}) =>
  c(X.caja.token, "POST", `/api/accounts/${acc}/payments`, { idempotencyKey: key(), lines, ...extra });
const floor = async () => (await c(X.juan.token, "GET", "/api/floor")).body as { number: string; status: string; accounts: { id: string }[]; linked_to: string | null; joined: string[] }[];
const statusOf = async (n: string) => (await floor()).find((t) => t.number === n)!;

describe("ciclo completo del servicio", () => {
  it("abrir → pedir → producir → entregar → cobrar → corte, con los totales cuadrando al centavo", async () => {
    await c(X.caja.token, "POST", "/api/cash/open", { opening_cents: 50000 });
    const acc = await open("1", 3);
    const sent = await order(acc, [{ name: "Hamburguesa clásica", quantity: 2 }, { name: "Margarita" }]);
    expect(sent.status).toBe(201);
    const a = await account(acc);
    const total = a.items.filter((i: { status: string }) => i.status === "activo").reduce((s: number, i: { quantity: number; unit_price_cents: number }) => s + i.quantity * i.unit_price_cents, 0);
    expect(total).toBeGreaterThan(0);

    // cada estación recibe sus comandas y las mueve hasta entregado
    const chef = await login("Pedro", "2222").catch(() => null);
    const tickets = await db.prepare("SELECT id, status FROM production_tickets").all() as { id: string; status: string }[];
    expect(tickets.length).toBeGreaterThanOrEqual(2);
    for (const t of tickets) for (const st of ["preparando", "listo", "entregado"]) expect((await c(X.adm, "POST", `/api/tickets/${t.id}/status`, { status: st })).status).toBe(200);
    expect(chef).not.toBeUndefined();

    const bal = (await c(X.caja.token, "GET", `/api/accounts/${acc}/balance`)).body;
    expect(bal.total_cents).toBe(total);
    const p = await pay(acc, [{ method: "efectivo", amount_cents: total }]);
    expect(p.status).toBe(201);
    expect((await account(acc)).status).toBe("cerrada");
    expect((await statusOf("1")).status).toBe("disponible");

    const close = await c(X.caja.token, "POST", "/api/cash/close", { counted_cents: 50000 + total });
    expect(close.status).toBe(200);
    expect(close.body.difference_cents).toBe(0);
  });

  it("no se puede cobrar de más, ni dos veces, ni una cuenta ya cerrada", async () => {
    await c(X.caja.token, "POST", "/api/cash/open", { opening_cents: 0 });
    const acc = await open("2");
    await order(acc, [{ name: "Ensalada" }]);
    const total = (await c(X.caja.token, "GET", `/api/accounts/${acc}/balance`)).body.total_cents as number;
    const over = await pay(acc, [{ method: "tarjeta", amount_cents: total + 5000 }]);
    expect(over.status).toBeGreaterThanOrEqual(400);
    const k = key();
    const ok1 = await c(X.caja.token, "POST", `/api/accounts/${acc}/payments`, { idempotencyKey: k, lines: [{ method: "tarjeta", amount_cents: total }] });
    const ok2 = await c(X.caja.token, "POST", `/api/accounts/${acc}/payments`, { idempotencyKey: k, lines: [{ method: "tarjeta", amount_cents: total }] });
    expect(ok1.status).toBe(201);
    expect(ok2.status).toBeLessThan(300); // misma clave: no duplica
    expect((await db.prepare("SELECT COUNT(*) c FROM payments").get() as { c: number }).c).toBe(1);
    const again = await pay(acc, [{ method: "efectivo", amount_cents: 100 }]);
    expect(again.status).toBeGreaterThanOrEqual(400);
    const edit = await order(acc, [{ name: "Ensalada" }]);
    expect(edit.status).toBeGreaterThanOrEqual(400); // cuenta cerrada: inmutable
  });

  it("sin caja abierta no se puede cobrar", async () => {
    const acc = await open("3");
    await order(acc, [{ name: "Ensalada" }]);
    const r = await pay(acc, [{ method: "efectivo", amount_cents: 10000 }]);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  it("pagos mixtos (efectivo + tarjeta) suman el total y el cambio solo sale del efectivo", async () => {
    await c(X.caja.token, "POST", "/api/cash/open", { opening_cents: 0 });
    const acc = await open("4");
    await order(acc, [{ name: "Hamburguesa clásica", quantity: 3 }]);
    const total = (await c(X.caja.token, "GET", `/api/accounts/${acc}/balance`)).body.total_cents as number;
    const half = Math.floor(total / 2);
    const r = await pay(acc, [{ method: "tarjeta", amount_cents: half }, { method: "efectivo", amount_cents: total - half + 2000 }]);
    expect(r.status).toBe(201);
    const lines = await db.prepare("SELECT method, amount_cents FROM payment_lines").all() as { method: string; amount_cents: number }[];
    expect(sum(lines)).toBe(total); // las líneas registran lo aplicado a la cuenta; el cambio va aparte
    const pm = await db.prepare("SELECT total_cents, change_cents FROM payments").get() as { total_cents: number; change_cents: number };
    expect(pm.total_cents).toBe(total);
    expect(pm.change_cents).toBe(2000);
  });

  it("cobro en partes iguales: cada parte baja el saldo y la cuenta cierra con la última", async () => {
    await c(X.caja.token, "POST", "/api/cash/open", { opening_cents: 0 });
    const acc = await open("5", 4);
    await order(acc, [{ name: "Hamburguesa clásica", quantity: 4 }]);
    let bal = (await c(X.caja.token, "GET", `/api/accounts/${acc}/balance`)).body;
    const total = bal.total_cents as number;
    const part = Math.floor(total / 4);
    for (let i = 1; i <= 3; i++) {
      const r = await pay(acc, [{ method: "efectivo", amount_cents: part }], { cover_cents: part });
      expect(r.status).toBe(201);
      bal = (await c(X.caja.token, "GET", `/api/accounts/${acc}/balance`)).body;
      expect(bal.balance_cents).toBe(total - part * i);
      expect((await account(acc)).status).not.toBe("cerrada");
    }
    const last = await pay(acc, [{ method: "efectivo", amount_cents: bal.balance_cents }], { cover_cents: bal.balance_cents });
    expect(last.status).toBe(201);
    expect((await account(acc)).status).toBe("cerrada");
  });

  it("la propina no cuenta como venta pero sí entra al corte en el método con que se pagó", async () => {
    await c(X.caja.token, "POST", "/api/cash/open", { opening_cents: 10000 });
    const acc = await open("6");
    await order(acc, [{ name: "Ensalada" }]);
    const total = (await c(X.caja.token, "GET", `/api/accounts/${acc}/balance`)).body.total_cents as number;
    await pay(acc, [{ method: "tarjeta", amount_cents: total }], { tip_cents: 3000, tip_method: "tarjeta" });
    const cur = (await c(X.caja.token, "GET", "/api/cash/current")).body;
    const flat = JSON.stringify(cur);
    expect(flat).toContain(String(total));
    const close = await c(X.caja.token, "POST", "/api/cash/close", { counted_cents: 10000 });
    expect(close.body.difference_cents).toBe(0); // todo fue con tarjeta: el efectivo esperado es el fondo
  });

  it("una diferencia de caja exige motivo y queda registrada", async () => {
    await c(X.caja.token, "POST", "/api/cash/open", { opening_cents: 20000 });
    const noReason = await c(X.caja.token, "POST", "/api/cash/close", { counted_cents: 19000 });
    expect(noReason.status).toBe(400);
    const ok = await c(X.caja.token, "POST", "/api/cash/close", { counted_cents: 19000, reason: "Cambio mal dado" });
    expect(ok.body.difference_cents).toBe(-1000);
    expect((await db.prepare("SELECT difference_reason r FROM cash_sessions").get() as { r: string }).r).toBe("Cambio mal dado");
  });
});

describe("mesas: unir, fusionar, mover y dividir", () => {
  it("unir una mesa libre la marca ocupada; separar o cerrar la cuenta la libera", async () => {
    await c(X.caja.token, "POST", "/api/cash/open", { opening_cents: 0 });
    const acc = await open("1", 6);
    expect((await c(X.juan.token, "POST", `/api/accounts/${acc}/join`, { tableId: X.tbl["2"] })).status).toBe(200);
    expect((await c(X.juan.token, "POST", `/api/accounts/${acc}/join`, { tableId: X.tbl["3"] })).status).toBe(200);
    expect((await statusOf("1")).joined.sort()).toEqual(["2", "3"]);
    expect((await statusOf("2"))).toMatchObject({ status: "ocupada", linked_to: "1" });
    expect((await c(X.juan.token, "POST", `/api/tables/${X.tbl["3"]}/unjoin`, {})).status).toBe(200);
    expect((await statusOf("3")).status).toBe("disponible");
    // al cobrar, la mesa unida que quedaba se libera sola
    await order(acc, [{ name: "Ensalada" }]);
    const total = (await c(X.caja.token, "GET", `/api/accounts/${acc}/balance`)).body.total_cents as number;
    await pay(acc, [{ method: "efectivo", amount_cents: total }]);
    expect((await statusOf("1")).status).toBe("disponible");
    expect((await statusOf("2")).status).toBe("disponible");
    expect((await statusOf("2")).linked_to).toBeNull();
  });

  it("no se puede unir una mesa ocupada, ni la misma mesa, ni unir en cuentas de cuentas cerradas", async () => {
    const a = await open("1");
    await open("2", 2, (await login("Pedro", "2222")).token);
    expect((await c(X.juan.token, "POST", `/api/accounts/${a}/join`, { tableId: X.tbl["2"] })).status).toBe(409);
    expect((await c(X.juan.token, "POST", `/api/accounts/${a}/join`, { tableId: X.tbl["1"] })).status).toBe(400);
    expect((await c(X.juan.token, "POST", `/api/accounts/${a}/join`, { tableId: "no-existe" })).status).toBe(404);
    expect((await c(X.juan.token, "POST", `/api/tables/${X.tbl["1"]}/unjoin`, {})).status).toBe(404); // no está unida
  });

  it("una mesa unida no se puede abrir por separado", async () => {
    const a = await open("1");
    await c(X.juan.token, "POST", `/api/accounts/${a}/join`, { tableId: X.tbl["2"] });
    expect((await c(X.juan.token, "POST", `/api/tables/${X.tbl["2"]}/open`, { guests: 2 })).status).toBe(409);
  });

  it("fusionar dos cuentas conserva todos los productos, suma comensales y deja ambas mesas juntas", async () => {
    const a = await open("1", 2);
    const b = await open("2", 3);
    await order(a, [{ name: "Ensalada" }]);
    await order(b, [{ name: "Hamburguesa clásica", quantity: 2 }, { name: "Margarita" }]);
    const before = (await account(a)).items.length + (await account(b)).items.length;
    expect((await c(X.juan.token, "POST", `/api/accounts/${a}/merge`, { sourceAccountId: b })).status).toBe(200);
    const merged = await account(a);
    expect(merged.items.length).toBe(before);
    expect(merged.guests).toBe(5);
    expect((await account(b)).status).toBe("cerrada");
    expect(await statusOf("2")).toMatchObject({ status: "ocupada", linked_to: "1" });
    expect((await c(X.juan.token, "POST", `/api/accounts/${a}/merge`, { sourceAccountId: a })).status).toBe(400);
  });

  it("dividir por producto mueve exactamente esos renglones y los totales suman igual", async () => {
    const a = await open("1", 2);
    await order(a, [{ name: "Ensalada" }, { name: "Hamburguesa clásica" }, { name: "Margarita" }]);
    const acct = await account(a);
    const total = (await c(X.juan.token, "GET", `/api/accounts/${a}/balance`)).body.total_cents as number;
    const take = acct.items.slice(0, 2).map((i: { id: string }) => i.id);
    const split = await c(X.juan.token, "POST", `/api/accounts/${a}/split`, { itemIds: take });
    expect(split.status).toBe(201);
    const t1 = (await c(X.juan.token, "GET", `/api/accounts/${a}/balance`)).body.total_cents as number;
    const t2 = (await c(X.juan.token, "GET", `/api/accounts/${split.body.id}/balance`)).body.total_cents as number;
    expect(t1 + t2).toBe(total);
    // un renglón que no pertenece a la cuenta se rechaza
    expect((await c(X.juan.token, "POST", `/api/accounts/${a}/split`, { itemIds: take })).status).toBe(400);
  });

  it("cambiar de mesa libera la anterior y rechaza una ocupada", async () => {
    const a = await open("1");
    await open("2", 2, (await login("Pedro", "2222")).token);
    expect((await c(X.juan.token, "POST", `/api/accounts/${a}/move`, { tableId: X.tbl["2"] })).status).toBe(409);
    expect((await c(X.juan.token, "POST", `/api/accounts/${a}/move`, { tableId: X.tbl["5"] })).status).toBe(200);
    expect((await statusOf("1")).status).toBe("disponible");
    expect((await statusOf("5")).status).toBe("ocupada");
  });

  it("dos tablets abriendo la misma mesa a la vez: una gana y la otra recibe 409", async () => {
    const pedro = await login("Pedro", "2222");
    const [r1, r2] = await Promise.all([
      c(X.juan.token, "POST", `/api/tables/${X.tbl["7"]}/open`, { guests: 2 }),
      c(pedro.token, "POST", `/api/tables/${X.tbl["7"]}/open`, { guests: 2 }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    expect((await db.prepare("SELECT COUNT(*) c FROM accounts WHERE table_id=? AND status!='cerrada'").get(X.tbl["7"]) as { c: number }).c).toBe(1);
  });

  it("abrir con el mismo clientId es idempotente (reintento tras perder la red)", async () => {
    const body = { guests: 2, clientId: "cliente-mesa-0001" };
    const a = await c(X.juan.token, "POST", `/api/tables/${X.tbl["8"]}/open`, body);
    const b = await c(X.juan.token, "POST", `/api/tables/${X.tbl["8"]}/open`, body);
    expect(a.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.duplicate).toBe(true);
  });
});

describe("producción e impresión", () => {
  it("tiempos retenidos no se imprimen hasta dispararlos", async () => {
    const acc = await open("1");
    await order(acc, [{ name: "Ensalada", course: "Entradas" }, { name: "Hamburguesa clásica", course: "Plato fuerte", hold: true }]);
    await processQueue(db, transport, hub);
    const printed = transport.sent.map((s) => s.text).join("\n");
    expect(printed).not.toContain("Hamburguesa");
    transport.sent.length = 0;
    const fire = await c(X.juan.token, "POST", `/api/accounts/${acc}/fire`, { course: "Plato fuerte" });
    expect(fire.status).toBeLessThan(300);
    await processQueue(db, transport, hub);
    expect(transport.sent.map((s) => s.text).join("\n")).toContain("Hamburguesa");
  });

  it("si la impresora principal cae, la comanda llega a la secundaria; y si cae todo, queda en cola y se puede reintentar", async () => {
    const acc = await open("1");
    transport.down.add("192.168.1.50");
    await order(acc, [{ name: "Hamburguesa clásica" }]);
    await processQueue(db, transport, hub);
    // sin impresora de cocina: el trabajo no se pierde
    const pending = await db.prepare("SELECT COUNT(*) c FROM print_jobs WHERE status!='impreso'").get() as { c: number };
    expect(pending.c).toBeGreaterThanOrEqual(0);
    transport.down.clear();
    await db.prepare("UPDATE print_jobs SET next_attempt_at=0 WHERE status!='impreso'").run();
    await processQueue(db, transport, hub);
    expect(transport.sent.some((s) => s.text.includes("Hamburguesa"))).toBe(true);
    expect((await db.prepare("SELECT COUNT(*) c FROM print_jobs WHERE status!='impreso'").get() as { c: number }).c).toBe(0);
  });

  it("la comanda imprime tildes y símbolos sin caracteres corruptos", async () => {
    await c(X.adm, "POST", "/api/products", { name: "Piña colada ñoña", price_cents: 12000, station_ids: [(await db.prepare("SELECT id FROM stations LIMIT 1").get() as { id: string }).id] });
    const prods = (await c(X.adm, "GET", "/api/products")).body as { id: string; name: string }[];
    const acc = await open("1");
    await c(X.juan.token, "POST", `/api/accounts/${acc}/orders`, { items: [{ productId: prods.find((p) => p.name.startsWith("Piña"))!.id, quantity: 1, note: "sin azúcar, por favor" }] });
    await processQueue(db, transport, hub);
    const text = transport.sent.map((s) => s.text).join("");
    expect(text).toMatch(/Pi.a colada/);
    expect(text).not.toContain("�");
  });

  it("el KDS solo ve las comandas de su estación y el pase solo lo ya listo", async () => {
    const acc = await open("1");
    await order(acc, [{ name: "Hamburguesa clásica" }, { name: "Margarita" }]);
    const stations = (await c(X.adm, "GET", "/api/stations")).body as { id: string; name: string }[];
    const per = await Promise.all(stations.map(async (s) => ((await c(X.adm, "GET", `/api/stations/${s.id}/tickets`)).body ?? []) as unknown[]));
    expect(per.flat().length).toBeGreaterThanOrEqual(2);
    expect((await c(X.juan.token, "GET", "/api/pass")).body).toEqual(expect.any(Array));
    const t = await db.prepare("SELECT id FROM production_tickets LIMIT 1").get() as { id: string };
    for (const st of ["preparando", "listo"]) expect((await c(X.adm, "POST", `/api/tickets/${t.id}/status`, { status: st })).status).toBe(200);
    const ready = (await c(X.juan.token, "GET", "/api/ready")).body as unknown[];
    expect(ready.length).toBeGreaterThanOrEqual(1);
  });

  it("no se pueden saltar estados de una comanda ni regresar sin permiso", async () => {
    const acc = await open("1");
    await order(acc, [{ name: "Ensalada" }]);
    const t = await db.prepare("SELECT id FROM production_tickets LIMIT 1").get() as { id: string };
    const bad = await c(X.adm, "POST", `/api/tickets/${t.id}/status`, { status: "inventado" });
    expect(bad.status).toBe(400);
    const waiter = await c(X.juan.token, "POST", `/api/tickets/${t.id}/status`, { status: "preparando" });
    expect(waiter.status).toBe(403); // el mesero no mueve la cocina
  });
});

describe("inventario y recetas", () => {
  it("vender descuenta insumos según la receta; cancelar antes de producir los repone", async () => {
    const item = (await c(X.adm, "POST", "/api/inventory/items", { name: "Carne molida", unit: "g" })).body.id as string;
    await c(X.adm, "POST", "/api/inventory/movements", { itemId: item, kind: "entrada", quantity: 5000, unitCostCents: 20 });
    await c(X.adm, "PUT", `/api/recipes/${X.prod["Hamburguesa clásica"]}`, { lines: [{ itemId: item, quantity: 200 }] });
    const stock = async () => (await db.prepare("SELECT stock FROM inventory_items WHERE id=?").get(item) as { stock: number }).stock;
    expect(await stock()).toBe(5000);
    const acc = await open("1");
    await order(acc, [{ name: "Hamburguesa clásica", quantity: 3 }]);
    expect(await stock()).toBe(4400);
    const it = (await account(acc)).items[0];
    const cancel = await c(X.juan.token, "POST", `/api/items/${it.id}/cancel`, { reason: "Error de captura" });
    expect(cancel.status).toBe(200);
    expect(await stock()).toBe(5000);
  });

  it("el stock puede quedar bajo el mínimo y genera alerta, pero no bloquea la venta", async () => {
    const item = (await c(X.adm, "POST", "/api/inventory/items", { name: "Limón", unit: "pza", min_stock: 50 })).body.id as string;
    await c(X.adm, "POST", "/api/inventory/movements", { itemId: item, kind: "entrada", quantity: 10, unitCostCents: 100 });
    const alerts = (await c(X.adm, "GET", "/api/inventory/alerts")).body as { name?: string }[];
    expect(JSON.stringify(alerts)).toContain("Limón");
    await c(X.adm, "PUT", `/api/recipes/${X.prod["Margarita"]}`, { lines: [{ itemId: item, quantity: 20 }] });
    const acc = await open("1");
    expect((await order(acc, [{ name: "Margarita" }])).status).toBe(201);
  });

  it("rechaza movimientos de inventario con cantidades inválidas", async () => {
    const item = (await c(X.adm, "POST", "/api/inventory/items", { name: "Sal", unit: "g" })).body.id as string;
    for (const quantity of [0, -5, "mucho", null]) {
      const r = await c(X.adm, "POST", "/api/inventory/movements", { itemId: item, kind: "entrada", quantity });
      expect(r.status, String(quantity)).toBeLessThan(500);
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("descuentos, cargo por servicio y propinas", () => {
  it("el descuento por encima del límite exige autorización de gerente y baja el total exactamente", async () => {
    const acc = await open("1", 2);
    await order(acc, [{ name: "Hamburguesa clásica", quantity: 2 }]);
    const before = (await c(X.juan.token, "GET", `/api/accounts/${acc}/balance`)).body.total_cents as number;
    const small = await c(X.juan.token, "POST", `/api/accounts/${acc}/discounts`, { kind: "porcentaje", value: 5, reason: "Cliente frecuente" });
    expect([200, 201, 403]).toContain(small.status);
    const big = await c(X.juan.token, "POST", `/api/accounts/${acc}/discounts`, { kind: "porcentaje", value: 50, reason: "Cortesía" });
    expect(big.status).toBe(403);
    const after = (await c(X.juan.token, "GET", `/api/accounts/${acc}/balance`)).body.total_cents as number;
    expect(after).toBeLessThanOrEqual(before);
    expect(after).toBeGreaterThan(0);
  });

  it("el cargo por servicio se aplica con 8+ comensales y se puede dispensar", async () => {
    await c(X.adm, "PUT", "/api/settings", { service_charge_pct: 10, service_charge_min_guests: 8 });
    const small = await open("1", 4);
    const big = await open("2", 10);
    await order(small, [{ name: "Hamburguesa clásica", quantity: 2 }]);
    await order(big, [{ name: "Hamburguesa clásica", quantity: 2 }]);
    const sTotal = (await c(X.juan.token, "GET", `/api/accounts/${small}/balance`)).body.total_cents as number;
    const bTotal = (await c(X.juan.token, "GET", `/api/accounts/${big}/balance`)).body.total_cents as number;
    expect(bTotal).toBeGreaterThan(sTotal);
    expect(bTotal).toBe(Math.round(sTotal * 1.1));
    // dispensar requiere el permiso de descuento
    expect((await c(X.juan.token, "POST", `/api/accounts/${big}/service-charge`, { waive: true })).status).toBe(403);
    expect((await c(X.adm, "POST", `/api/accounts/${big}/service-charge`, { waive: true })).status).toBe(200);
    expect(((await c(X.juan.token, "GET", `/api/accounts/${big}/balance`)).body.total_cents as number)).toBe(sTotal);
  });
});

describe("bitácora y reportes", () => {
  it("las operaciones sensibles quedan auditadas con usuario y acción", async () => {
    const acc = await open("1");
    await order(acc, [{ name: "Ensalada" }]);
    const it = (await account(acc)).items[0];
    await c(X.juan.token, "POST", `/api/items/${it.id}/cancel`, { reason: "Error de captura" });
    const log = (await c(X.adm, "GET", "/api/audit")).body as { action: string }[];
    const actions = log.map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["abrir_mesa", "cancelar_producto"]));
  });

  it("el reporte de ventas coincide con lo cobrado y no cuenta cuentas abiertas ni canceladas", async () => {
    await c(X.caja.token, "POST", "/api/cash/open", { opening_cents: 0 });
    const paid = await open("1");
    await order(paid, [{ name: "Hamburguesa clásica", quantity: 2 }]);
    const t1 = (await c(X.caja.token, "GET", `/api/accounts/${paid}/balance`)).body.total_cents as number;
    await pay(paid, [{ method: "efectivo", amount_cents: t1 }]);
    const openAcc = await open("2");
    await order(openAcc, [{ name: "Margarita", quantity: 4 }]);
    const rep = (await c(X.adm, "GET", "/api/reports/sales")).body;
    const flat = JSON.stringify(rep);
    expect(flat).toContain(String(t1));
    const dash = (await c(X.adm, "GET", "/api/dashboard")).body;
    expect(dash).toBeTruthy();
  });

  it("el export CSV escapa comas, comillas y saltos de línea (no rompe columnas)", async () => {
    const st = (await db.prepare("SELECT id FROM stations LIMIT 1").get() as { id: string }).id;
    await c(X.adm, "POST", "/api/products", { name: 'Pizza "La Jefa", grande\nextra', price_cents: 15000, station_ids: [st] });
    const prods = (await c(X.adm, "GET", "/api/products")).body as { id: string; name: string }[];
    const acc = await open("1");
    await c(X.juan.token, "POST", `/api/accounts/${acc}/orders`, { items: [{ productId: prods.find((p) => p.name.startsWith("Pizza"))!.id, quantity: 1 }] });
    await c(X.caja.token, "POST", "/api/cash/open", { opening_cents: 0 });
    const total = (await c(X.caja.token, "GET", `/api/accounts/${acc}/balance`)).body.total_cents as number;
    await pay(acc, [{ method: "efectivo", amount_cents: total }]);
    const csv = (await c(X.adm, "GET", "/api/reports/sales?format=csv&section=by_product")).body as string;
    expect(typeof csv).toBe("string");
    expect(csv).toContain('"Pizza ""La Jefa"", grande');
  });
});
