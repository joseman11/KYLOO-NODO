import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { openDb, type Db } from "../src/db";
import { Hub } from "../src/hub";
import { seed } from "../src/seed";
import { computeTotals } from "../src/cfdi";
import {
  generateSigningKeys,
  getLicense,
  signLicense,
  verifyLicense,
  GRACE_DAYS,
} from "../src/license";
import { processWebhooks, sign, type FetchLike } from "../src/webhooks";
import { buildSalesDays, syncWithHq, type HttpLike } from "../src/routes/cloud";
import type { PrinterTransport } from "../src/printing/transport";

const okTransport: PrinterTransport = { send: async () => undefined, ping: async () => true };

let app: FastifyInstance;
let db: Db;
let hub: Hub;
let n = 0;
const key = () => `k3-${++n}-${Math.random().toString(36).slice(2)}`;
const H = (t: string) => ({ Authorization: `Bearer ${t}` });
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function call(
  a: FastifyInstance,
  headers: Record<string, string>,
  method: Method,
  url: string,
  payload?: unknown,
) {
  const r = await a.inject({ method, url, headers, payload: payload as object });
  const ct = String(r.headers["content-type"] ?? "");
  return {
    status: r.statusCode,
    body: r.body && ct.includes("json") ? r.json() : r.body,
    headers: r.headers,
  };
}
const c = (t: string, method: Method, url: string, payload?: unknown) =>
  call(app, H(t), method, url, payload);

async function pin(name: string, p: string) {
  const users = (await app.inject({ method: "GET", url: "/api/auth/users" })).json() as {
    id: string;
    name: string;
  }[];
  const u = users.find((x) => x.name === name)!;
  return {
    token: (
      await app.inject({ method: "POST", url: "/api/auth/pin", payload: { userId: u.id, pin: p } })
    ).json().token as string,
    id: u.id,
  };
}
async function admin() {
  return (
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "admin1234" },
    })
  ).json().token as string;
}
const prod = async (t: string, name: string) =>
  ((await c(t, "GET", "/api/products")).body as { id: string; name: string }[]).find(
    (p) => p.name === name,
  )!.id;
const tableId = async (t: string, num: string) =>
  ((await c(t, "GET", "/api/tables")).body as { id: string; number: string }[]).find(
    (x) => x.number === num,
  )!.id;

/** Abre mesa, envía comanda y cobra: devuelve el id de la cuenta ya pagada. */
async function sale(
  items: { name: string; quantity?: number }[],
  table = "1",
  method = "efectivo",
) {
  const adm = await admin();
  const juan = await pin("Juan", "1111");
  const acc = (
    await c(juan.token, "POST", `/api/tables/${await tableId(adm, table)}/open`, { guests: 2 })
  ).body.id as string;
  const payload = {
    items: await Promise.all(
      items.map(async (i) => ({ productId: await prod(adm, i.name), quantity: i.quantity ?? 1 })),
    ),
  };
  await c(juan.token, "POST", `/api/accounts/${acc}/orders`, payload);
  const caja = await pin("Caja", "3333");
  if ((await c(caja.token, "GET", "/api/cash/current")).status === 404)
    await c(caja.token, "POST", "/api/cash/open", { opening_cents: 0 });
  const total = (
    (await c(caja.token, "GET", `/api/accounts/${acc}`)).body as { total_cents: number }
  ).total_cents;
  const pay = await c(caja.token, "POST", `/api/accounts/${acc}/payments`, {
    idempotencyKey: key(),
    lines: [{ method, amount_cents: total }],
  });
  expect(pay.status).toBe(201);
  return { acc, total, adm, juan, caja };
}

beforeEach(async () => {
  db = await openDb(":memory:");
  await seed(db, "admin1234");
  hub = new Hub();
  app = buildApp(db, { transport: okTransport, hub });
});

// ───────────────────────── Analítica ─────────────────────────
describe("analítica", () => {
  it("calcula ticket promedio, productos por comanda, rotación y desglose por hora", async () => {
    await sale([{ name: "Hamburguesa clásica" }, { name: "Margarita", quantity: 2 }], "1"); // 14900 + 17800 = 32700
    const { adm } = await sale([{ name: "Ensalada" }], "2"); // 9900
    const o = (await c(adm, "GET", "/api/analytics/overview")).body;
    expect(o).toMatchObject({ tickets: 2, sales_cents: 42600, average_ticket_cents: 21300 });
    expect(o.items_per_order).toBe(2); // (3 + 1) unidades / 2 comandas
    expect(o.tables_served).toBe(2);
    expect(o.table_rotation).toBeGreaterThan(0);
    expect(o.avg_attention_minutes).toBeGreaterThanOrEqual(0);
    expect(o.by_hour.reduce((s: number, h: { tickets: number }) => s + h.tickets, 0)).toBe(2);
    expect(o.previous.sales_cents).toBe(0);
    expect(o.change_sales_pct).toBeNull(); // sin periodo anterior no hay porcentaje
  });

  it("mide tiempos de preparación por estación y marca los retrasos", async () => {
    const adm = await admin();
    const juan = await pin("Juan", "1111");
    const acc = (await c(juan.token, "POST", `/api/tables/${await tableId(adm, "1")}/open`, {}))
      .body.id as string;
    await c(juan.token, "POST", `/api/accounts/${acc}/orders`, {
      items: [{ productId: await prod(adm, "Hamburguesa clásica") }],
    });
    const t = (await db.prepare("SELECT id FROM production_tickets").get()) as { id: string };
    await db
      .prepare("UPDATE production_tickets SET created_at=? WHERE id=?")
      .run(Date.now() - 20 * 60_000, t.id); // llegó hace 20 min
    await c(adm, "POST", `/api/tickets/${t.id}/status`, { status: "preparando" });
    await c(adm, "POST", `/api/tickets/${t.id}/status`, { status: "listo" });
    const rows = (await c(adm, "GET", "/api/analytics/prep-times")).body as {
      station: string;
      avg_minutes: number;
      late: number;
    }[];
    expect(rows[0]).toMatchObject({ station: "Plancha", late: 1 });
    expect(rows[0]!.avg_minutes).toBeGreaterThanOrEqual(19);
  });

  it("clasifica productos en A, B y C por participación acumulada (ABC)", async () => {
    await sale([{ name: "Hamburguesa clásica", quantity: 20 }], "1"); // 298000
    await sale([{ name: "Margarita", quantity: 1 }], "2"); // 8900
    const { adm } = await sale([{ name: "Ensalada", quantity: 1 }], "3"); // 9900
    const abc = (await c(adm, "GET", "/api/analytics/abc")).body as {
      product: string;
      class: string;
      share_pct: number;
    }[];
    expect(abc.map((r) => r.product)).toEqual(["Hamburguesa clásica", "Ensalada", "Margarita"]);
    expect(abc[0]!.class).toBe("A");
    expect(abc.at(-1)!.class).toBe("C");
    expect(abc.reduce((s, r) => s + r.share_pct, 0)).toBeGreaterThan(99);
  });

  it("pronostica por día de la semana con las últimas semanas", async () => {
    const { adm } = await sale([{ name: "Hamburguesa clásica" }]);
    const f = (await c(adm, "GET", "/api/analytics/forecast?weeks=4")).body as {
      weekday: number;
      samples: number;
      expected_sales_cents: number | null;
      peak_hour: number | null;
    }[];
    expect(f).toHaveLength(7);
    const today = f.find((d) => d.weekday === new Date().getDay())!;
    expect(today).toMatchObject({ samples: 1, expected_sales_cents: 14900 });
    expect(today.peak_hour).toBe(new Date().getHours());
    expect(f.filter((d) => d.samples === 0).every((d) => d.expected_sales_cents === null)).toBe(
      true,
    );
  });

  it("solo quien puede ver reportes consulta analítica", async () => {
    const juan = await pin("Juan", "1111");
    expect((await c(juan.token, "GET", "/api/analytics/overview")).status).toBe(403);
  });
});

// ───────────────────────── Integraciones y webhooks ─────────────────────────
describe("integraciones", () => {
  async function setup() {
    const adm = await admin();
    const station = (
      (await db.prepare("SELECT id FROM stations WHERE name='Plancha'").get()) as { id: string }
    ).id;
    await c(adm, "POST", "/api/products", {
      name: "Pizza",
      sku: "PZ-1",
      price_cents: 12000,
      station_ids: [station],
    });
    const integ = (
      await c(adm, "POST", "/api/integrations", { name: "Rappi", kind: "delivery_app" })
    ).body as { id: string; api_key: string };
    return { adm, k: { "x-api-key": integ.api_key }, integ };
  }
  const orderBody = (ref: string, sku = "PZ-1") => ({
    external_ref: ref,
    kind: "delivery",
    customer: { name: "Luis", phone: "555", address: "Calle 1" },
    fee_cents: 2500,
    items: [{ sku, quantity: 2 }],
  });

  it("recibe un pedido por SKU, lo envía a cocina y es idempotente por referencia externa", async () => {
    const { adm, k } = await setup();
    const r = await call(app, k, "POST", "/api/integrations/orders", orderBody("R-1"));
    expect(r.status).toBe(201);
    expect(r.body.label).toBe("D1");
    expect(await db.prepare("SELECT COUNT(*) c FROM production_tickets").get()).toEqual({ c: 1 });
    const acct = (await c(adm, "GET", `/api/accounts/${r.body.id}`)).body;
    expect(acct.total_cents).toBe(24000 + 2500);
    expect(await db.prepare("SELECT source FROM orders").get()).toEqual({ source: "api:Rappi" });

    const dup = await call(app, k, "POST", "/api/integrations/orders", orderBody("R-1"));
    expect(dup.status).toBe(200);
    expect(dup.body).toMatchObject({ id: r.body.id, duplicate: true });
    expect(
      await db.prepare("SELECT COUNT(*) c FROM accounts WHERE integration_id IS NOT NULL").get(),
    ).toEqual({ c: 1 });

    const st = await call(app, k, "GET", "/api/integrations/orders/R-1");
    expect(st.body).toMatchObject({ status: "recibido", label: "D1" });
  });

  it("rechaza llaves inválidas, SKU desconocidos y deja reintentar si el producto estaba agotado", async () => {
    const { adm, k, integ } = await setup();
    expect(
      (
        await call(
          app,
          { "x-api-key": "ik_falsa" },
          "POST",
          "/api/integrations/orders",
          orderBody("R-2"),
        )
      ).status,
    ).toBe(401);
    const unknown = await call(
      app,
      k,
      "POST",
      "/api/integrations/orders",
      orderBody("R-2", "NOEXISTE"),
    );
    expect(unknown.status).toBe(422);
    expect(unknown.body.message).toContain("NOEXISTE");

    const pizza = await prod(adm, "Pizza");
    await c(adm, "POST", `/api/products/${pizza}/availability`, { availability: "agotado" });
    expect((await call(app, k, "POST", "/api/integrations/orders", orderBody("R-3"))).status).toBe(
      409,
    );
    expect(await db.prepare("SELECT COUNT(*) c FROM accounts").get()).toEqual({ c: 0 }); // no queda una cuenta huérfana
    await c(adm, "POST", `/api/products/${pizza}/availability`, { availability: "disponible" });
    expect((await call(app, k, "POST", "/api/integrations/orders", orderBody("R-3"))).status).toBe(
      201,
    );

    await c(adm, "PATCH", `/api/integrations/${integ.id}`, { active: false });
    expect((await call(app, k, "POST", "/api/integrations/orders", orderBody("R-4"))).status).toBe(
      401,
    );
  });

  it("solo administración gestiona integraciones", async () => {
    const juan = await pin("Juan", "1111");
    expect(
      (await c(juan.token, "POST", "/api/integrations", { name: "x", kind: "web" })).status,
    ).toBe(403);
  });
});

describe("webhooks", () => {
  it("firma cada entrega con HMAC y reintenta con espera creciente hasta marcar error", async () => {
    const adm = await admin();
    const wh = (
      await c(adm, "POST", "/api/webhooks", {
        url: "https://erp.example/hook",
        events: ["order.created"],
      })
    ).body as { id: string; secret: string };
    const juan = await pin("Juan", "1111");
    const acc = (await c(juan.token, "POST", `/api/tables/${await tableId(adm, "1")}/open`, {}))
      .body.id as string;
    await c(juan.token, "POST", `/api/accounts/${acc}/orders`, {
      items: [{ productId: await prod(adm, "Ensalada") }],
    });
    // table.updated no está suscrito; solo order.created
    expect(await db.prepare("SELECT COUNT(*) c FROM webhook_deliveries").get()).toEqual({ c: 1 });

    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const good: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return { ok: true, status: 200 };
    };
    expect(await processWebhooks(db, good)).toBe(1);
    expect(calls[0]!.headers["x-003-signature"]).toBe(
      `sha256=${createHmac("sha256", wh.secret).update(calls[0]!.body).digest("hex")}`,
    );
    expect(calls[0]!.headers["x-003-signature"]).toBe(sign(wh.secret, calls[0]!.body));
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      event: "order.created",
      data: { accountId: acc },
    });

    // Un endpoint caído: reintentos y, tras 6 intentos, error visible y reintentable
    await db
      .prepare(
        "INSERT INTO webhook_deliveries (id,endpoint_id,event,payload,next_attempt_at,created_at) VALUES ('d2',?,?,?,?,?)",
      )
      .run(wh.id, "order.created", "{}", 0, 0);
    const bad: FetchLike = async () => ({ ok: false, status: 503 });
    let now = Date.now();
    for (let i = 0; i < 6; i++) {
      await processWebhooks(db, bad, now);
      now += 10 * 60_000;
    }
    expect(
      await db
        .prepare("SELECT status, attempts, last_error FROM webhook_deliveries WHERE id='d2'")
        .get(),
    ).toEqual({ status: "error", attempts: 6, last_error: "HTTP 503" });
    const failed = (await c(adm, "GET", "/api/webhooks")).body as { failed: number }[];
    expect(failed[0]!.failed).toBe(1);
    expect((await c(adm, "POST", "/api/webhooks/deliveries/d2/retry")).status).toBe(200);
    expect(await processWebhooks(db, good, now)).toBe(1);
  });

  it("rechaza URL que no sean http(s) y no expone el secreto después de crearlo", async () => {
    const adm = await admin();
    expect((await c(adm, "POST", "/api/webhooks", { url: "file:///etc/passwd" })).status).toBe(400);
    await c(adm, "POST", "/api/webhooks", { url: "https://a.example/h" });
    const list = JSON.stringify((await c(adm, "GET", "/api/webhooks")).body);
    expect(list).not.toContain("whsec_");
  });
});

// ───────────────────────── Sincronización offline ─────────────────────────
describe("sincronización por lotes", () => {
  it("aplica abrir mesa + comanda + cuenta sin conexión y reenviar el lote no duplica nada", async () => {
    const adm = await admin();
    const juan = await pin("Juan", "1111");
    const t = await tableId(adm, "3");
    const burger = await prod(adm, "Hamburguesa clásica");
    const batch = {
      ops: [
        { id: "op-open-0001", type: "open_table", tableId: t, guests: 3 },
        {
          id: "op-order-001",
          type: "order",
          accountRef: "op-open-0001",
          items: [{ productId: burger, quantity: 2 }],
        },
        { id: "op-bill-0001", type: "request_bill", accountRef: "op-open-0001" },
      ],
    };
    const r1 = await c(juan.token, "POST", "/api/sync", batch);
    expect(r1.body.results.map((r: { status: string }) => r.status)).toEqual(["ok", "ok", "ok"]);
    const acc = (await db.prepare("SELECT id, status, guests FROM accounts").get()) as {
      id: string;
      status: string;
      guests: number;
    };
    expect(acc).toMatchObject({ status: "pago_solicitado", guests: 3 });

    const r2 = await c(juan.token, "POST", "/api/sync", batch);
    expect(r2.body.results.map((r: { status: string }) => r.status)).toEqual([
      "duplicate",
      "duplicate",
      "duplicate",
    ]);
    expect(await db.prepare("SELECT COUNT(*) c FROM accounts").get()).toEqual({ c: 1 });
    expect(await db.prepare("SELECT COUNT(*) c FROM orders").get()).toEqual({ c: 1 });
    expect((await c(adm, "GET", `/api/accounts/${acc.id}`)).body.total_cents).toBe(29800);
  });

  it("reporta conflicto cuando otra tablet ocupó la mesa mientras no había red, y en cadena sus comandas", async () => {
    const adm = await admin();
    const juan = await pin("Juan", "1111");
    const pedro = await pin("Pedro", "2222");
    const t = await tableId(adm, "4");
    await c(pedro.token, "POST", `/api/tables/${t}/open`, { guests: 2 }); // Pedro la abrió primero (en línea)
    const burger = await prod(adm, "Hamburguesa clásica");
    const r = await c(juan.token, "POST", "/api/sync", {
      ops: [
        { id: "op-open-0002", type: "open_table", tableId: t },
        {
          id: "op-order-002",
          type: "order",
          accountRef: "op-open-0002",
          items: [{ productId: burger }],
        },
      ],
    });
    expect(r.body.results[0]).toMatchObject({ status: "conflict", code: "mesa_ocupada" });
    expect(r.body.results[1]).toMatchObject({ status: "conflict", code: "cuenta_no_abierta" });
    expect(await db.prepare("SELECT COUNT(*) c FROM orders").get()).toEqual({ c: 0 });
  });

  it("marca como conflicto un producto que se agotó y valida el formato de las operaciones", async () => {
    const adm = await admin();
    const juan = await pin("Juan", "1111");
    const acc = (await c(juan.token, "POST", `/api/tables/${await tableId(adm, "5")}/open`, {}))
      .body.id as string;
    const marg = await prod(adm, "Margarita");
    await c(adm, "POST", `/api/products/${marg}/availability`, { availability: "agotado" });
    const r = await c(juan.token, "POST", "/api/sync", {
      ops: [
        { id: "op-order-003", type: "order", accountId: acc, items: [{ productId: marg }] },
        { id: "op-bad-0001", type: "teletransportar" },
      ],
    });
    expect(r.body.results[0]).toMatchObject({ status: "conflict", code: "producto_agotado" });
    expect(r.body.results[1]).toMatchObject({ status: "error", code: "validacion" });
  });
});

// ───────────────────────── Facturación ─────────────────────────
describe("facturación", () => {
  const fiscal = {
    rfc: "xaxx010101000",
    razon_social: "Cliente Prueba SA",
    regimen_fiscal: "601",
    cp: "06600",
    uso_cfdi: "G03",
    email: "cliente@example.com",
  };
  const emisor = {
    fiscal_rfc: "EKU9003173C9",
    fiscal_name: "Restaurante Demo SA",
    fiscal_regimen: "601",
    fiscal_cp: "64000",
  };

  it("las cifras del CFDI siempre cuadran al centavo: subtotal − descuento + IVA = total", () => {
    const cases: [number, { quantity: number; unitGrossCents: number }[]][] = [
      [
        32700,
        [
          { quantity: 1, unitGrossCents: 14900 },
          { quantity: 2, unitGrossCents: 8900 },
          { quantity: 1, unitGrossCents: 0 },
        ],
      ],
      [29590, [{ quantity: 3, unitGrossCents: 9990 }]],
      [1, [{ quantity: 1, unitGrossCents: 1 }]],
      [
        100001,
        [
          { quantity: 7, unitGrossCents: 14333 },
          { quantity: 1, unitGrossCents: 77 },
        ],
      ],
    ];
    for (const [total, items] of cases) {
      const { totals, netByLine } = computeTotals(
        items.map((i) => ({ ...i, description: "x" })),
        total,
      );
      expect(totals.subtotalCents - totals.discountCents + totals.ivaCents).toBe(totals.totalCents);
      expect(netByLine.reduce((s, v) => s + v, 0)).toBe(totals.subtotalCents);
      expect(totals.ivaCents).toBeGreaterThanOrEqual(0);
    }
  });

  it("emite una factura de prueba (sin timbre ni UUID) de una cuenta pagada con descuento y envío", async () => {
    const { acc, adm } = await sale([
      { name: "Hamburguesa clásica" },
      { name: "Margarita", quantity: 2 },
    ]);
    expect((await c(adm, "POST", `/api/accounts/${acc}/invoice`, { fiscal })).status).toBe(409); // sin datos del emisor
    expect((await c(adm, "PUT", "/api/settings", emisor)).status).toBe(200);

    const r = await c(adm, "POST", `/api/accounts/${acc}/invoice`, { fiscal });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      serie: "A",
      folio: 1,
      uuid: null,
      sandbox: true,
      total_cents: 32700,
    });

    const xml = (await c(adm, "GET", `/api/invoices/${r.body.id}/xml`)).body as string;
    expect(xml).toContain("PRUEBA");
    expect(xml).toContain('Version="4.0"');
    expect(xml).toContain('Rfc="XAXX010101000"'); // RFC en mayúsculas
    expect(xml).toContain('Total="327.00"');
    expect(xml).not.toContain("TimbreFiscalDigital"); // nunca se simula un timbre
    expect(xml.match(/<cfdi:Concepto /g)).toHaveLength(2);

    expect((await c(adm, "POST", `/api/accounts/${acc}/invoice`, { fiscal })).status).toBe(409); // ya facturada
    const html = (await c(adm, "GET", `/api/invoices/${r.body.id}/html`)).body as string;
    expect(html).toContain("sin validez fiscal");
  });

  it("valida el RFC y que la cuenta esté cobrada; cancela con motivo y permite refacturar", async () => {
    const { acc, adm } = await sale([{ name: "Ensalada" }]);
    await c(adm, "PUT", "/api/settings", emisor);
    expect(
      (await c(adm, "POST", `/api/accounts/${acc}/invoice`, { fiscal: { ...fiscal, rfc: "123" } }))
        .status,
    ).toBe(400);

    const juan = await pin("Juan", "1111");
    const open = (await c(juan.token, "POST", `/api/tables/${await tableId(adm, "2")}/open`, {}))
      .body.id as string;
    await c(juan.token, "POST", `/api/accounts/${open}/orders`, {
      items: [{ productId: await prod(adm, "Ensalada") }],
    });
    expect((await c(adm, "POST", `/api/accounts/${open}/invoice`, { fiscal })).status).toBe(409); // sin pagar

    const inv = (await c(adm, "POST", `/api/accounts/${acc}/invoice`, { fiscal })).body
      .id as string;
    expect((await c(adm, "POST", `/api/invoices/${inv}/cancel`, { motivo: "99" })).status).toBe(
      400,
    );
    expect(
      (
        await c(adm, "POST", `/api/invoices/${inv}/cancel`, {
          motivo: "02",
          note: "RFC mal capturado",
        })
      ).status,
    ).toBe(200);
    expect((await c(adm, "POST", `/api/invoices/${inv}/cancel`, { motivo: "02" })).status).toBe(
      409,
    );
    const again = await c(adm, "POST", `/api/accounts/${acc}/invoice`, { fiscal });
    expect(again.status).toBe(201);
    expect(again.body.folio).toBe(2);
    const list = (await c(adm, "GET", `/api/invoices?accountId=${acc}`)).body as {
      status: string;
    }[];
    expect(list.map((i) => i.status).sort()).toEqual(["cancelada", "emitida"]);
  });

  it("el reenvío publica un evento y un mesero no puede facturar", async () => {
    const { acc, adm } = await sale([{ name: "Ensalada" }]);
    await c(adm, "PUT", "/api/settings", emisor);
    const inv = (await c(adm, "POST", `/api/accounts/${acc}/invoice`, { fiscal })).body
      .id as string;
    const events: string[] = [];
    hub.subscribe((e) => e.type === "invoice.resend" && events.push(String(e.email)));
    expect(
      (await c(adm, "POST", `/api/invoices/${inv}/resend`, { email: "otro@example.com" })).body,
    ).toMatchObject({ ok: true, delivery: "evento" });
    expect(events).toEqual(["otro@example.com"]);
    const juan = await pin("Juan", "1111");
    expect((await c(juan.token, "GET", "/api/invoices")).status).toBe(403);
  });
});

// ───────────────────────── Nube (HQ), multi-tenant y planes ─────────────────────────
describe("HQ, multi-tenant y licencias", () => {
  let hqApp: FastifyInstance;
  const ADMIN = { "x-hq-admin": "secreto-plataforma" };

  const http =
    (target: FastifyInstance): HttpLike =>
    async (url, init) => {
      const u = new URL(url);
      const r = await target.inject({
        method: (init?.method ?? "GET") as Method,
        url: u.pathname + u.search,
        headers: init?.headers,
        payload: init?.body,
      });
      return { ok: r.statusCode < 400, status: r.statusCode, json: async () => r.json() };
    };

  async function newOrg(name: string, plan: string, username: string) {
    const org = await call(hqApp, ADMIN, "POST", "/api/hq/orgs", {
      name,
      plan,
      owner: { username, password: "clave-segura-1" },
    });
    expect(org.status).toBe(201);
    const token = (
      await hqApp.inject({
        method: "POST",
        url: "/api/hq/login",
        payload: { username, password: "clave-segura-1" },
      })
    ).json().token as string;
    return { orgId: org.body.id as string, token };
  }
  async function newBranch(token: string, name: string) {
    const r = await call(hqApp, H(token), "POST", "/api/hq/branches", { name });
    return r;
  }

  beforeEach(async () => {
    hqApp = buildApp(await openDb(":memory:"), { hq: { adminToken: "secreto-plataforma" } });
    // La sucursal (este servidor) habla con el HQ en memoria, sin red
    app = buildApp(db, { transport: okTransport, hub, http: http(hqApp) });
  });

  async function link(branchKey: string) {
    const adm = await admin();
    const r = await c(adm, "POST", "/api/cloud/link", { url: "http://hq.test", key: branchKey });
    expect(r.status).toBe(200);
    return adm;
  }

  it("solo la plataforma crea organizaciones; el login exige credenciales válidas", async () => {
    expect(
      (
        await call(hqApp, {}, "POST", "/api/hq/orgs", {
          name: "X",
          owner: { username: "x-owner", password: "clave-segura-1" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call(hqApp, { "x-hq-admin": "mala" }, "POST", "/api/hq/orgs", {
          name: "X",
          owner: { username: "x-owner", password: "clave-segura-1" },
        })
      ).status,
    ).toBe(401);
    await newOrg("Tacos SA", "gratis", "tacos-owner");
    expect(
      (
        await hqApp.inject({
          method: "POST",
          url: "/api/hq/login",
          payload: { username: "tacos-owner", password: "incorrecta" },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("el plan limita las sucursales y se puede mejorar el plan", async () => {
    const { orgId, token } = await newOrg("Tacos SA", "gratis", "tacos-owner");
    expect((await newBranch(token, "Centro")).status).toBe(201);
    const second = await newBranch(token, "Norte");
    expect(second.status).toBe(402);
    expect(second.body.error).toBe("limite_plan");
    await call(hqApp, ADMIN, "PATCH", `/api/hq/orgs/${orgId}`, { plan: "profesional" });
    expect((await newBranch(token, "Norte")).status).toBe(201);
    expect(
      ((await call(hqApp, H(token), "GET", "/api/hq/me")).body as { branches_used: number })
        .branches_used,
    ).toBe(2);
  });

  it("consolida ventas de varias sucursales y aísla por completo a cada organización", async () => {
    const a = await newOrg("Org A", "empresarial", "a-owner");
    const b = await newOrg("Org B", "empresarial", "b-owner");
    const a1 = (await newBranch(a.token, "A Centro")).body as { api_key: string };
    const a2 = (await newBranch(a.token, "A Norte")).body as { api_key: string };
    const b1 = (await newBranch(b.token, "B Unica")).body as { api_key: string };

    // La sucursal "A Centro" es este servidor: vende y sincroniza
    await sale([{ name: "Hamburguesa clásica" }, { name: "Margarita", quantity: 2 }]); // 32700
    await link(a1.api_key);
    const adm = await admin();
    const rep = (await c(adm, "POST", "/api/cloud/sync")).body; // sincronización desde la API de la sucursal
    expect(rep).toMatchObject({
      sales: { ok: true, days: 1 },
      license: { ok: true, plan: "empresarial" },
      catalog: { ok: true },
    });

    const run = (apiKey: string) => syncWithHq(db, http(hqApp)).then(() => apiKey);
    await run(a1.api_key);
    // Las otras sucursales envían sus ventas directamente
    const ingest = (key: string, sales: number, tickets: number) =>
      call(hqApp, { "x-branch-key": key }, "POST", "/api/hq/ingest", {
        days: [
          {
            day: new Date().toISOString().slice(0, 10),
            tickets,
            sales_cents: sales,
            products: [{ product: "Hamburguesa clásica", units: tickets, sales_cents: sales }],
          },
        ],
      });
    expect((await ingest(a2.api_key, 50000, 4)).status).toBe(200);
    expect((await ingest(b1.api_key, 999999, 9)).status).toBe(200);

    const sumA = (await call(hqApp, H(a.token), "GET", "/api/hq/reports/summary")).body;
    expect(sumA.branches).toHaveLength(2);
    expect(sumA.total).toMatchObject({ tickets: 5, sales_cents: 32700 + 50000 });
    expect(JSON.stringify(sumA)).not.toContain("B Unica");
    const sumB = (await call(hqApp, H(b.token), "GET", "/api/hq/reports/summary")).body;
    expect(sumB.total.sales_cents).toBe(999999);
    const prodsA = (await call(hqApp, H(a.token), "GET", "/api/hq/reports/products")).body as {
      product: string;
      units: number;
    }[];
    expect(prodsA.find((p) => p.product === "Hamburguesa clásica")!.units).toBe(1 + 4);

    // Reenviar el mismo día no duplica (se reemplaza)
    await run(a1.api_key);
    expect(
      (await call(hqApp, H(a.token), "GET", "/api/hq/reports/summary")).body.total.sales_cents,
    ).toBe(82700);

    // Una llave de sucursal no sirve como sesión de organización ni al revés
    expect(
      (await call(hqApp, { "x-branch-key": a1.api_key }, "GET", "/api/hq/reports/summary")).status,
    ).toBe(401);
    expect((await call(hqApp, H(a.token), "POST", "/api/hq/ingest", { days: [] })).status).toBe(
      401,
    );
    expect(
      (await call(hqApp, { "x-branch-key": "bk_falsa" }, "POST", "/api/hq/ingest", { days: [] }))
        .status,
    ).toBe(401);
  });

  it("distribuye el catálogo maestro: resuelve estaciones por nombre y omite lo que no puede producirse", async () => {
    const org = await newOrg("Org C", "profesional", "c-owner");
    const br = (await newBranch(org.token, "C1")).body as { api_key: string };
    const put = await call(hqApp, H(org.token), "PUT", "/api/hq/catalog", {
      products: [
        {
          sku: "NEW-1",
          name: "Tacos al pastor",
          price_cents: 8500,
          category: "Antojitos",
          station_names: ["Plancha"],
        },
        {
          sku: "NEW-2",
          name: "Cóctel nuevo",
          price_cents: 9500,
          category: "Bebidas",
          station_names: ["Barra"],
        },
        {
          sku: "NEW-3",
          name: "Sin estación local",
          price_cents: 100,
          station_names: ["Horno de leña"],
        },
      ],
    });
    expect(put.status).toBe(200);
    await link(br.api_key);
    const report = await syncWithHq(db, http(hqApp));
    expect(report.catalog).toMatchObject({ ok: true, created: 2 });
    expect(report.catalog.skipped).toEqual([
      { sku: "NEW-3", reason: "Sin estación local: Horno de leña" },
    ]);
    const adm = await admin();
    const tacos = (
      (await c(adm, "GET", "/api/products")).body as { name: string; station_ids: string[] }[]
    ).find((p) => p.name === "Tacos al pastor")!;
    expect(tacos.station_ids).toHaveLength(1);

    // Cambiar el precio en HQ actualiza la sucursal sin duplicar
    await call(hqApp, H(org.token), "PUT", "/api/hq/catalog", {
      products: [
        {
          sku: "NEW-1",
          name: "Tacos al pastor",
          price_cents: 9000,
          category: "Antojitos",
          station_names: ["Plancha"],
        },
      ],
    });
    const second = await syncWithHq(db, http(hqApp));
    expect(second.catalog).toMatchObject({ created: 0, updated: 2 }); // el catálogo maestro completo se reaplica; el producto sin estación sigue omitido
    expect(await db.prepare("SELECT COUNT(*) c FROM products WHERE sku='NEW-1'").get()).toEqual({
      c: 1,
    });
    expect(await db.prepare("SELECT price_cents FROM products WHERE sku='NEW-1'").get()).toEqual({
      price_cents: 9000,
    });
  });

  it("la licencia del plan limita funciones y usuarios, y mejorar el plan los libera tras sincronizar", async () => {
    const org = await newOrg("Org D", "gratis", "d-owner");
    const br = (await newBranch(org.token, "D1")).body as { api_key: string };
    const adm = await link(br.api_key);

    // Sin licencia instalada: sin límites (instalación propia)
    expect((await c(adm, "GET", "/api/inventory/items")).status).toBe(200);
    expect(
      (await c(adm, "POST", "/api/users", { name: "Extra 1", role: "mesero", pin: "9001" })).status,
    ).toBe(201);

    const rep = await syncWithHq(db, http(hqApp));
    expect(rep.license).toMatchObject({ ok: true, plan: "gratis" });
    const status = (await c(adm, "GET", "/api/cloud/status")).body;
    expect(status).toMatchObject({ linked: true, license: { plan: "gratis", expired: false } });

    // Plan gratis: sin inventario, ni QR, ni analítica; y 3 usuarios como máximo (ya hay 5)
    const blocked = await c(adm, "GET", "/api/inventory/items");
    expect(blocked.status).toBe(402);
    expect(blocked.body).toMatchObject({ error: "plan_no_incluye", feature: "inventario" });
    expect((await c(adm, "GET", "/api/analytics/overview")).status).toBe(402);
    expect(
      (await c(adm, "POST", "/api/users", { name: "Extra 2", role: "mesero", pin: "9002" })).body
        .error,
    ).toBe("limite_plan");
    expect((await c(adm, "POST", "/api/printers", { name: "Otra", kind: "bar" })).body.error).toBe(
      "limite_plan",
    );
    // Vender sigue funcionando siempre
    const juan = await pin("Juan", "1111");
    expect(
      (await c(juan.token, "POST", `/api/tables/${await tableId(adm, "6")}/open`, {})).status,
    ).toBe(201);

    await call(hqApp, ADMIN, "PATCH", `/api/hq/orgs/${org.orgId}`, { plan: "profesional" });
    await syncWithHq(db, http(hqApp));
    expect((await c(adm, "GET", "/api/inventory/items")).status).toBe(200);
    expect((await c(adm, "GET", "/api/analytics/overview")).status).toBe(200);
    expect(
      (await c(adm, "POST", "/api/users", { name: "Extra 2", role: "mesero", pin: "9002" })).status,
    ).toBe(201);

    // Desvincular quita la licencia y los límites
    await c(adm, "POST", "/api/cloud/unlink");
    expect(await getLicense(db)).toBeNull();
  });

  it("una licencia manipulada o firmada por otro HQ se rechaza; vencida pierde funciones tras la gracia", async () => {
    const keys = generateSigningKeys();
    const other = generateSigningKeys();
    const now = Date.now();
    const payload = {
      org: "o",
      branch: "b",
      plan: "empresarial",
      limits: { users: null, printers: null },
      features: ["inventario"] as const,
      iat: now,
      exp: now + 1000,
    };
    const token = signLicense(keys.privateKey, payload as never);
    expect(verifyLicense(keys.publicKey, token)).toMatchObject({ plan: "empresarial" });
    expect(verifyLicense(other.publicKey, token)).toBeNull();
    const [body, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...payload, features: ["inventario", "facturacion"] }),
    ).toString("base64url");
    expect(verifyLicense(keys.publicKey, `${forged}.${sig}`)).toBeNull();
    expect(body).toBeTruthy();

    const put = (k: string, v: string) =>
      db
        .prepare(
          "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(k, v);
    await put("hq_public_key", keys.publicKey);
    await put("license", token);
    expect(await getLicense(db, now)).toMatchObject({ plan: "empresarial", expired: false });
    expect(await getLicense(db, now + 2000)).toMatchObject({ plan: "empresarial", expired: true }); // dentro de la gracia sigue operando
    expect(await getLicense(db, now + 1000 + (GRACE_DAYS + 1) * 86_400_000)).toMatchObject({
      plan: "gratis",
    });
    await put("license", "basura.basura");
    expect(await getLicense(db)).toMatchObject({ plan: "gratis" });
  });

  it("sin conexión a la nube los pasos fallan por separado y la sucursal sigue operando", async () => {
    const org = await newOrg("Org E", "profesional", "e-owner");
    const br = (await newBranch(org.token, "E1")).body as { api_key: string };
    const adm = await link(br.api_key);
    const down: HttpLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const rep = await syncWithHq(db, down);
    expect(rep.sales.ok).toBe(false);
    expect(rep.license.ok).toBe(false);
    expect(rep.catalog.ok).toBe(false);
    const juan = await pin("Juan", "1111");
    expect(
      (await c(juan.token, "POST", `/api/tables/${await tableId(adm, "7")}/open`, {})).status,
    ).toBe(201);
    expect(await buildSalesDays(db)).toEqual([]);
  });

  it("no permite sincronizar una sucursal sin vincular", async () => {
    const adm = await admin();
    expect((await c(adm, "POST", "/api/cloud/sync")).status).toBe(409);
  });
});
