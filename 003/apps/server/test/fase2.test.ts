import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { openDb, type Db } from "../src/db";
import { Hub } from "../src/hub";
import { isPromoActive, promoAmount } from "../src/routes/promotions";
import { seed } from "../src/seed";
import type { PrinterTransport } from "../src/printing/transport";

const okTransport: PrinterTransport = { send: async () => undefined, ping: async () => true };

let app: FastifyInstance;
let db: Db;
let hub: Hub;
let n = 0;
const key = () => `k2-${++n}-${Math.random().toString(36).slice(2)}`;
const H = (t: string) => ({ Authorization: `Bearer ${t}` });

async function pin(name: string, p: string) {
  const users = (await app.inject({ method: "GET", url: "/api/auth/users" })).json() as { id: string; name: string }[];
  const u = users.find((x) => x.name === name)!;
  const r = await app.inject({ method: "POST", url: "/api/auth/pin", payload: { userId: u.id, pin: p } });
  return { token: r.json().token as string, id: u.id };
}
async function admin() {
  return (await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin1234" } })).json().token as string;
}
const call = async (token: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers: H(token), payload: payload as object });
  return { status: r.statusCode, body: r.body ? (r.headers["content-type"]?.toString().includes("json") ? r.json() : r.body) : null };
};
const products = async (t: string) => (await call(t, "GET", "/api/products")).body as { id: string; name: string }[];
const prod = async (t: string, name: string) => (await products(t)).find((p) => p.name === name)!.id;
const tableId = async (t: string, num: string) => ((await call(t, "GET", "/api/tables")).body as { id: string; number: string }[]).find((x) => x.number === num)!.id;

async function openAccount(token: string, num = "1") {
  const r = await call(token, "POST", `/api/tables/${await tableId(token, num)}/open`, { guests: 2 });
  return r.body.id as string;
}
const send = (token: string, accountId: string, items: unknown[]) => call(token, "POST", `/api/accounts/${accountId}/orders`, { items });

beforeEach(() => {
  db = openDb(":memory:");
  seed(db, "admin1234");
  hub = new Hub();
  app = buildApp(db, { transport: okTransport, hub });
});

describe("migración", () => {
  it("las cuentas aceptan table_id nulo y conservan datos tras la reconstrucción", () => {
    const cols = db.prepare("PRAGMA table_info(accounts)").all() as { name: string; notnull: number }[];
    expect(cols.find((c) => c.name === "table_id")!.notnull).toBe(0);
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(["kind", "label", "customer_id"]));
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});

describe("inventario y recetas", () => {
  async function setup() {
    const adm = await admin();
    const mk = async (name: string, unit: string, min: number, cost: number) =>
      (await call(adm, "POST", "/api/inventory/items", { name, unit, min_stock: min, unit_cost_cents: cost })).body.id as string;
    const carne = await mk("Carne", "g", 500, 0.2);
    const pan = await mk("Pan", "pza", 5, 4);
    await call(adm, "POST", "/api/inventory/movements", { itemId: carne, kind: "entrada", quantity: 1000, unit_cost_cents: 0.2 });
    await call(adm, "POST", "/api/inventory/movements", { itemId: pan, kind: "entrada", quantity: 10, unit_cost_cents: 4 });
    const burger = await prod(adm, "Hamburguesa clásica");
    await call(adm, "PUT", `/api/recipes/${burger}`, { lines: [{ itemId: carne, quantity: 180 }, { itemId: pan, quantity: 1 }] });
    return { adm, carne, pan, burger };
  }
  const stock = (adm: string, id: string) => db.prepare("SELECT stock FROM inventory_items WHERE id=?").get(id) as { stock: number } & unknown && (db.prepare("SELECT stock FROM inventory_items WHERE id=?").get(id) as { stock: number }).stock;

  it("enviar una comanda descuenta los ingredientes de la receta", async () => {
    const { adm, carne, pan, burger } = await setup();
    const juan = await pin("Juan", "1111");
    const acc = await openAccount(juan.token);
    await send(juan.token, acc, [{ productId: burger, quantity: 2 }]);
    expect(stock(adm, carne)).toBe(640);
    expect(stock(adm, pan)).toBe(8);
  });

  it("cancelar antes de producción devuelve el inventario; después de producción no", async () => {
    const { adm, carne, burger } = await setup();
    const juan = await pin("Juan", "1111");
    const acc = await openAccount(juan.token);
    await send(juan.token, acc, [{ productId: burger }]);
    const item = ((await call(juan.token, "GET", `/api/accounts/${acc}`)).body.items as { id: string }[])[0]!;
    await call(juan.token, "POST", `/api/items/${item.id}/cancel`, { reason: "Error de captura" });
    expect(stock(adm, carne)).toBe(1000);

    await send(juan.token, acc, [{ productId: burger }]);
    expect(stock(adm, carne)).toBe(820);
    const t = db.prepare("SELECT id FROM production_tickets WHERE status='pendiente'").get() as { id: string };
    await call(adm, "POST", `/api/tickets/${t.id}/status`, { status: "preparando" });
    const item2 = ((await call(juan.token, "GET", `/api/accounts/${acc}`)).body.items as { id: string; status: string }[]).find((i) => i.status === "activo")!;
    await call(adm, "POST", "/api/users", { name: "Gerente", role: "gerente", pin: "5555" });
    const g = await pin("Gerente", "5555");
    const r = await call(juan.token, "POST", `/api/items/${item2.id}/cancel`, { reason: "Cliente canceló", authorizerId: g.id, authorizerPin: "5555" });
    expect(r.status).toBe(200);
    expect(stock(adm, carne)).toBe(820); // ya se preparó: es consumo
  });

  it("emite alerta de stock bajo y permite stock negativo", async () => {
    const { adm, burger } = await setup();
    const alerts: string[] = [];
    hub.subscribe((e) => e.type === "inventory.alert" && alerts.push(`${e.name}:${e.level}`));
    const juan = await pin("Juan", "1111");
    const acc = await openAccount(juan.token);
    await send(juan.token, acc, [{ productId: burger, quantity: 3 }]); // carne: 1000-540=460 < 500
    expect(alerts).toContain("Carne:bajo");
    await send(juan.token, acc, [{ productId: burger, quantity: 9 }]); // 460-1620 <0
    expect(alerts).toContain("Carne:negativo");
    const list = (await call(adm, "GET", "/api/inventory/alerts")).body as { level: string }[];
    expect(list.some((a) => a.level === "negativo")).toBe(true);
  });

  it("un producto sin receta no toca inventario", async () => {
    const { adm, carne } = await setup();
    const juan = await pin("Juan", "1111");
    const acc = await openAccount(juan.token);
    await send(juan.token, acc, [{ productId: await prod(adm, "Margarita") }]);
    expect(stock(adm, carne)).toBe(1000);
  });

  it("la merma y el ajuste exigen motivo; el inventario físico genera ajustes", async () => {
    const { adm, carne } = await setup();
    expect((await call(adm, "POST", "/api/inventory/movements", { itemId: carne, kind: "merma", quantity: 50 })).status).toBe(400);
    expect((await call(adm, "POST", "/api/inventory/movements", { itemId: carne, kind: "merma", quantity: 50, reason: "Caducó" })).status).toBe(201);
    expect(stock(adm, carne)).toBe(950);
    const r = await call(adm, "POST", "/api/inventory/count", { lines: [{ itemId: carne, counted: 900 }] });
    expect(r.body.adjusted[0].difference).toBe(-50);
    expect(stock(adm, carne)).toBe(900);
  });

  it("un mesero no puede ver ni modificar inventario", async () => {
    const juan = await pin("Juan", "1111");
    expect((await call(juan.token, "GET", "/api/inventory/items")).status).toBe(403);
    expect((await call(juan.token, "POST", "/api/inventory/movements", { itemId: "x", kind: "entrada", quantity: 1 })).status).toBe(403);
  });
});

describe("compras y costos", () => {
  it("recibir una compra suma existencias y recalcula el costo promedio ponderado", async () => {
    const adm = await admin();
    const item = (await call(adm, "POST", "/api/inventory/items", { name: "Queso", unit: "pza", unit_cost_cents: 10 })).body.id as string;
    await call(adm, "POST", "/api/inventory/movements", { itemId: item, kind: "entrada", quantity: 10, unit_cost_cents: 10 });
    const sup = (await call(adm, "POST", "/api/suppliers", { name: "Lácteos SA" })).body.id as string;
    const po = (await call(adm, "POST", "/api/purchase-orders", { supplierId: sup, lines: [{ itemId: item, quantity: 10, unit_cost_cents: 20 }] })).body.id as string;
    expect((await call(adm, "POST", `/api/purchase-orders/${po}/receive`, { invoice_ref: "F-1" })).status).toBe(200);
    const row = db.prepare("SELECT stock, unit_cost_cents FROM inventory_items WHERE id=?").get(item) as { stock: number; unit_cost_cents: number };
    expect(row.stock).toBe(20);
    expect(row.unit_cost_cents).toBe(15);
    // no se puede recibir dos veces
    expect((await call(adm, "POST", `/api/purchase-orders/${po}/receive`, {})).status).toBe(409);
    const list = (await call(adm, "GET", `/api/purchase-orders?supplierId=${sup}`)).body as { status: string; total_cents: number }[];
    expect(list[0]).toMatchObject({ status: "recibida", total_cents: 200 });
  });

  it("calcula costo y margen por producto", async () => {
    const adm = await admin();
    const item = (await call(adm, "POST", "/api/inventory/items", { name: "Carne", unit: "g", unit_cost_cents: 10 })).body.id as string;
    const burger = await prod(adm, "Hamburguesa clásica"); // 14900
    await call(adm, "PUT", `/api/recipes/${burger}`, { lines: [{ itemId: item, quantity: 180 }] });
    const costs = (await call(adm, "GET", "/api/inventory/costs")).body as { cost_cents: number; margin_cents: number }[];
    expect(costs[0]).toMatchObject({ cost_cents: 1800, margin_cents: 13100 });
  });
});

describe("descuentos y promociones", () => {
  async function accountWithItems() {
    const adm = await admin();
    const juan = await pin("Juan", "1111");
    const acc = await openAccount(juan.token);
    await send(juan.token, acc, [{ productId: await prod(adm, "Hamburguesa clásica") }, { productId: await prod(adm, "Margarita"), quantity: 3 }]);
    return { adm, juan, acc }; // 14900 + 3*8900 = 41600
  }

  it("descuento dentro del límite lo aplica el mesero; sobre el límite exige gerente (RN-007)", async () => {
    const { adm, juan, acc } = await accountWithItems();
    expect((await call(juan.token, "POST", `/api/accounts/${acc}/discounts`, { kind: "porcentaje", value: 5, reason: "Cortesía" })).status).toBe(201);
    const denied = await call(juan.token, "POST", `/api/accounts/${acc}/discounts`, { kind: "porcentaje", value: 20, reason: "Cliente frecuente" });
    expect(denied.status).toBe(403);
    await call(adm, "POST", "/api/users", { name: "Gerente", role: "gerente", pin: "5555" });
    const g = await pin("Gerente", "5555");
    const ok = await call(juan.token, "POST", `/api/accounts/${acc}/discounts`, { kind: "porcentaje", value: 20, reason: "Cliente frecuente", authorizerId: g.id, authorizerPin: "5555" });
    expect(ok.status).toBe(201);
    const a = (await call(juan.token, "GET", `/api/accounts/${acc}`)).body;
    expect(a.discount_cents).toBe(2080 + 8320);
    expect(a.total_cents).toBe(41600 - 2080 - 8320);
    // el descuento queda auditado con quien lo autorizó
    const log = db.prepare("SELECT detail FROM audit_log WHERE action='descuento' ORDER BY id DESC").get() as { detail: string };
    expect(JSON.parse(log.detail).authorizedBy).toBe(g.id);
  });

  it("el cobro usa el total con descuento", async () => {
    const { juan, acc } = await accountWithItems();
    await call(juan.token, "POST", `/api/accounts/${acc}/discounts`, { kind: "monto", value: 1600, reason: "Cortesía" }); // 3.8% < 10%
    const caja = await pin("Caja", "3333");
    await call(caja.token, "POST", "/api/cash/open", { opening_cents: 0 });
    const low = await call(caja.token, "POST", `/api/accounts/${acc}/payments`, { idempotencyKey: key(), lines: [{ method: "tarjeta", amount_cents: 41600 }] });
    expect(low.status).toBe(400); // excede lo que se debe con tarjeta
    const ok = await call(caja.token, "POST", `/api/accounts/${acc}/payments`, { idempotencyKey: key(), lines: [{ method: "tarjeta", amount_cents: 40000 }] });
    expect(ok.status).toBe(201);
    expect((await call(juan.token, "POST", `/api/accounts/${acc}/discounts`, { kind: "monto", value: 100, reason: "tarde" })).status).toBe(409); // cuenta cerrada
  });

  it("2x1 regala la unidad más barata de cada par", async () => {
    const { adm, juan, acc } = await accountWithItems();
    const marg = await prod(adm, "Margarita");
    await call(adm, "POST", "/api/promotions", { name: "2x1 Margaritas", kind: "2x1", product_id: marg });
    const sug = (await call(juan.token, "GET", `/api/accounts/${acc}/promotions`)).body as { id: string; amount_cents: number }[];
    expect(sug).toHaveLength(1);
    expect(sug[0]!.amount_cents).toBe(8900); // 3 margaritas → 1 gratis
    const applied = await call(juan.token, "POST", `/api/accounts/${acc}/promotions/${sug[0]!.id}/apply`);
    expect(applied.status).toBe(201);
    expect((await call(juan.token, "POST", `/api/accounts/${acc}/promotions/${sug[0]!.id}/apply`)).status).toBe(409); // no se aplica dos veces
    expect((await call(juan.token, "GET", `/api/accounts/${acc}`)).body.total_cents).toBe(41600 - 8900);
  });

  it("happy hour: solo aplica dentro de su horario y día", () => {
    const base = { id: "p", name: "HH", kind: "porcentaje", value: 20, product_id: null, category_id: null, valid_from: null, valid_to: null, active: 1 } as const;
    const wed1830 = new Date(2026, 8, 30, 18, 30); // 30-sep-2026 es miércoles
    const hh = { ...base, days: "1,2,3,4,5", start_minute: 17 * 60, end_minute: 20 * 60 };
    expect(isPromoActive(hh, wed1830)).toBe(true);
    expect(isPromoActive(hh, new Date(2026, 8, 30, 21, 0))).toBe(false);
    expect(isPromoActive(hh, new Date(2026, 9, 3, 18, 30))).toBe(false); // sábado
    expect(isPromoActive({ ...hh, active: 0 }, wed1830)).toBe(false);
    const night = { ...base, days: null, start_minute: 22 * 60, end_minute: 2 * 60 };
    expect(isPromoActive(night, new Date(2026, 8, 30, 23, 30))).toBe(true);
    expect(isPromoActive(night, new Date(2026, 9, 1, 1, 0))).toBe(true);
    expect(isPromoActive(night, new Date(2026, 8, 30, 12, 0))).toBe(false);
  });

  it("calcula precio especial y monto fijo", () => {
    const lines = [{ product_id: "a", category_id: null, quantity: 2, unit_price_cents: 10000 }];
    const p = { id: "p", name: "x", value: 7000, product_id: "a", category_id: null, days: null, start_minute: null, end_minute: null, valid_from: null, valid_to: null, active: 1 } as const;
    expect(promoAmount({ ...p, kind: "precio_especial" }, lines)).toBe(6000);
    expect(promoAmount({ ...p, kind: "monto", value: 99999 }, lines)).toBe(20000);
  });
});

describe("clientes y reservaciones", () => {
  it("guarda clientes, los liga a la cuenta y muestra el historial", async () => {
    const adm = await admin();
    const juan = await pin("Juan", "1111");
    const cid = (await call(juan.token, "POST", "/api/customers", { name: "Ana López", phone: "5551234567", rfc: "XAXX010101000" })).body.id as string;
    const acc = await openAccount(juan.token);
    await call(juan.token, "POST", `/api/accounts/${acc}/customer`, { customerId: cid });
    await send(juan.token, acc, [{ productId: await prod(adm, "Margarita"), quantity: 2 }]);
    const caja = await pin("Caja", "3333");
    await call(caja.token, "POST", "/api/cash/open", { opening_cents: 0 });
    await call(caja.token, "POST", `/api/accounts/${acc}/payments`, { idempotencyKey: key(), lines: [{ method: "efectivo", amount_cents: 17800 }] });
    const h = (await call(juan.token, "GET", `/api/customers/${cid}/history`)).body;
    expect(h.total_spent_cents).toBe(17800);
    expect(h.favorites[0]).toMatchObject({ name: "Margarita", units: 2 });
    expect(((await call(juan.token, "GET", "/api/customers?q=Ana")).body as unknown[]).length).toBe(1);
  });

  it("evita reservaciones traslapadas y permite sentar al cliente", async () => {
    const juan = await pin("Juan", "1111");
    const t = await tableId(juan.token, "4");
    const at = Date.now() + 3_600_000;
    const r1 = await call(juan.token, "POST", "/api/reservations", { name: "Familia Pérez", party_size: 4, at, table_id: t });
    expect(r1.status).toBe(201);
    expect((await call(juan.token, "POST", "/api/reservations", { name: "Otra", party_size: 2, at: at + 30 * 60_000, table_id: t })).status).toBe(409);
    await call(juan.token, "POST", `/api/reservations/${r1.body.id}/status`, { status: "confirmada" });
    const seat = await call(juan.token, "POST", `/api/reservations/${r1.body.id}/seat`, {});
    expect(seat.status).toBe(201);
    expect((await call(juan.token, "GET", `/api/accounts/${seat.body.accountId}`)).body.guests).toBe(4);
    // ya llegó: no puede cancelarse
    expect((await call(juan.token, "POST", `/api/reservations/${r1.body.id}/status`, { status: "cancelada" })).status).toBe(409);
  });
});

describe("para llevar y delivery", () => {
  it("un pedido para llevar usa el mismo flujo, con folio L1 y sin mesa", async () => {
    const adm = await admin();
    const juan = await pin("Juan", "1111");
    const r = await call(juan.token, "POST", "/api/orders/external", { kind: "llevar", contact_name: "Luis", phone: "555" });
    expect(r.body.label).toBe("L1");
    await send(juan.token, r.body.id, [{ productId: await prod(adm, "Hamburguesa clásica") }]);
    const queue = db.prepare("SELECT id FROM stations WHERE name='Plancha'").get() as { id: string };
    const q = (await call(adm, "GET", `/api/stations/${queue.id}/queue`)).body as { table_number: string }[];
    expect(q[0]!.table_number).toBe("L1");
    const caja = await pin("Caja", "3333");
    await call(caja.token, "POST", "/api/cash/open", { opening_cents: 0 });
    expect((await call(caja.token, "POST", `/api/accounts/${r.body.id}/payments`, { idempotencyKey: key(), lines: [{ method: "efectivo", amount_cents: 14900 }] })).status).toBe(201);
    const second = await call(juan.token, "POST", "/api/orders/external", { kind: "llevar", contact_name: "Marta" });
    expect(second.body.label).toBe("L2");
  });

  it("delivery: requiere dirección, suma el envío y sigue a producción hasta 'listo' y 'en camino'", async () => {
    const adm = await admin();
    const juan = await pin("Juan", "1111");
    expect((await call(juan.token, "POST", "/api/orders/external", { kind: "delivery", contact_name: "Rosa" })).status).toBe(400);
    const d = await call(juan.token, "POST", "/api/orders/external", { kind: "delivery", contact_name: "Rosa", address: "Calle 1", fee_cents: 3000 });
    expect(d.body.label).toBe("D1");
    await send(juan.token, d.body.id, [{ productId: await prod(adm, "Hamburguesa clásica") }]);
    expect((await call(juan.token, "GET", `/api/accounts/${d.body.id}`)).body.total_cents).toBe(14900 + 3000);

    const ticket = db.prepare("SELECT id FROM production_tickets").get() as { id: string };
    await call(adm, "POST", `/api/tickets/${ticket.id}/status`, { status: "preparando" });
    const status = () => ((db.prepare("SELECT status FROM delivery_info").get() as { status: string }).status);
    expect(status()).toBe("preparando");
    await call(adm, "POST", `/api/tickets/${ticket.id}/status`, { status: "listo" });
    expect(status()).toBe("listo");

    expect((await call(juan.token, "POST", `/api/delivery/${d.body.id}/status`, { status: "en_camino" })).status).toBe(400); // sin repartidor
    expect((await call(juan.token, "POST", `/api/delivery/${d.body.id}/status`, { status: "en_camino", driver: "Carlos" })).status).toBe(200);
    expect((await call(juan.token, "POST", `/api/delivery/${d.body.id}/status`, { status: "preparando" })).status).toBe(409);
    expect((await call(juan.token, "POST", `/api/delivery/${d.body.id}/status`, { status: "entregado" })).status).toBe(200);
    const list = (await call(juan.token, "GET", "/api/delivery?all=true")).body as { label: string; total_cents: number; driver: string }[];
    expect(list[0]).toMatchObject({ label: "D1", total_cents: 17900, driver: "Carlos" });
  });

  it("los tickets listos aparecen en la lista de 'listos para entregar'", async () => {
    const adm = await admin();
    const juan = await pin("Juan", "1111");
    const acc = await openAccount(juan.token);
    await send(juan.token, acc, [{ productId: await prod(adm, "Ensalada") }]);
    const t = db.prepare("SELECT id FROM production_tickets").get() as { id: string };
    await call(adm, "POST", `/api/tickets/${t.id}/status`, { status: "preparando" });
    await call(adm, "POST", `/api/tickets/${t.id}/status`, { status: "listo" });
    const ready = (await call(juan.token, "GET", "/api/ready")).body as { table_number: string; station: string }[];
    expect(ready[0]).toMatchObject({ table_number: "1", station: "Cocina / Fríos" });
    await call(juan.token, "POST", `/api/tickets/${t.id}/status`, { status: "entregado" });
    expect(((await call(juan.token, "GET", "/api/ready")).body as unknown[]).length).toBe(0);
  });
});

describe("menú QR", () => {
  async function qr(num = "2") {
    const adm = await admin();
    const id = await tableId(adm, num);
    const path = (await call(adm, "GET", `/api/tables/${id}/qr`)).body.path as string;
    return { adm, id, t: new URL(path, "http://x").searchParams.get("t")! };
  }

  it("el menú público requiere un token firmado válido", async () => {
    const { t } = await qr();
    const ok = await app.inject({ method: "GET", url: `/api/public/menu?t=${t}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().table.number).toBe("2");
    expect(ok.json().can_order).toBe(false);
    const forged = t.split(".")[0] + ".00000000000000000000000000000000";
    expect((await app.inject({ method: "GET", url: `/api/public/menu?t=${forged}` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/public/menu?t=basura" })).statusCode).toBe(401);
  });

  it("solo se puede pedir si la mesa tiene cuenta abierta, y la comanda llega a producción", async () => {
    const { adm, t } = await qr("2");
    const body = { t, items: [{ productId: await prod(adm, "Margarita"), quantity: 2 }] };
    expect((await app.inject({ method: "POST", url: "/api/public/order", payload: body })).statusCode).toBe(409);
    const juan = await pin("Juan", "1111");
    const acc = await openAccount(juan.token, "2");
    const r = await app.inject({ method: "POST", url: "/api/public/order", payload: body });
    expect(r.statusCode).toBe(201);
    expect(db.prepare("SELECT source FROM orders").get()).toEqual({ source: "qr" });
    expect((await call(juan.token, "GET", `/api/accounts/${acc}`)).body.total_cents).toBe(17800);
    // no puede ordenar más de 10 renglones
    const many = await app.inject({ method: "POST", url: "/api/public/order", payload: { t, items: Array(11).fill(body.items[0]) } });
    expect(many.statusCode).toBe(400);
  });

  it("llamar al mesero notifica en tiempo real y tiene límite de frecuencia", async () => {
    const { t } = await qr("3");
    const events: string[] = [];
    hub.subscribe((e) => e.type === "waiter.called" && events.push(`${e.tableNumber}:${e.reason}`));
    expect((await app.inject({ method: "POST", url: "/api/public/call", payload: { t, reason: "mesero" } })).statusCode).toBe(202);
    expect(events).toEqual(["3:mesero"]);
    expect((await app.inject({ method: "POST", url: "/api/public/call", payload: { t, reason: "mesero" } })).statusCode).toBe(429);
    expect((await app.inject({ method: "POST", url: "/api/public/call", payload: { t, reason: "cuenta" } })).statusCode).toBe(202);
  });
});

describe("ajustes", () => {
  it("el límite de descuento es configurable y el secreto JWT no se expone", async () => {
    const adm = await admin();
    const juan = await pin("Juan", "1111");
    expect((await call(juan.token, "PUT", "/api/settings", { discount_limit_pct: 50 })).status).toBe(403);
    expect((await call(adm, "PUT", "/api/settings", { discount_limit_pct: 30, establishment_name: "La Brasa" })).status).toBe(200);
    expect((await call(adm, "PUT", "/api/settings", { jwt_secret: "x" })).status).toBe(400);
    const s = (await call(juan.token, "GET", "/api/settings")).body;
    expect(s).toMatchObject({ establishment_name: "La Brasa", discount_limit_pct: 30 });
    expect(Object.keys(s)).not.toContain("jwt_secret");

    const acc = await openAccount(juan.token);
    await send(juan.token, acc, [{ productId: await prod(adm, "Hamburguesa clásica") }]);
    expect((await call(juan.token, "POST", `/api/accounts/${acc}/discounts`, { kind: "porcentaje", value: 25, reason: "Prueba" })).status).toBe(201);
  });

  it("expone las direcciones de red local para armar los enlaces del QR", async () => {
    const juan = await pin("Juan", "1111");
    const net = (await call(juan.token, "GET", "/api/network")).body as { addresses: string[] };
    expect(Array.isArray(net.addresses)).toBe(true);
    expect(net.addresses.every((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a))).toBe(true);
  });
});
