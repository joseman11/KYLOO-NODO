import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { openDb, type Db } from "../src/db";
import { Hub } from "../src/hub";
import { processQueue } from "../src/printing/queue";
import { seed } from "../src/seed";
import { distributeTips, splitByWeight } from "../src/tips";
import type { PrinterTarget, PrinterTransport } from "../src/printing/transport";

class FakeTransport implements PrinterTransport {
  sent: { host: string | null; text: string }[] = [];
  async send(t: PrinterTarget, data: Buffer) {
    this.sent.push({ host: t.host, text: data.toString("latin1") });
  }
  async ping() {
    return true;
  }
}

const photosDir = mkdtempSync(join(tmpdir(), "003-photos-"));
afterAll(() => rmSync(photosDir, { recursive: true, force: true }));

let app: FastifyInstance;
let db: Db;
let hub: Hub;
let transport: FakeTransport;
let n = 0;
const key = () => `k4-${++n}-${Math.random().toString(36).slice(2)}`;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const c = async (t: string, method: Method, url: string, payload?: unknown) => {
  const r = await app.inject({
    method,
    url,
    headers: { Authorization: `Bearer ${t}` },
    payload: payload as object,
  });
  const json = r.body && String(r.headers["content-type"]).includes("json");
  return { status: r.statusCode, body: json ? r.json() : r.body, headers: r.headers };
};
const admin = async () =>
  (
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "admin1234" },
    })
  ).json().token as string;
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
const prod = async (t: string, name: string) =>
  ((await c(t, "GET", "/api/products")).body as { id: string; name: string }[]).find(
    (p) => p.name === name,
  )!.id;
const tableId = async (t: string, num: string) =>
  ((await c(t, "GET", "/api/tables")).body as { id: string; number: string }[]).find(
    (x) => x.number === num,
  )!.id;
const open = async (t: string, num = "1", guests = 1) =>
  (await c(t, "POST", `/api/tables/${await tableId(t, num)}/open`, { guests })).body.id as string;

const jpeg = (size = 400) =>
  `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, 7)]).toString("base64")}`;

beforeEach(async () => {
  db = await openDb(":memory:");
  await seed(db, "admin1234");
  hub = new Hub();
  transport = new FakeTransport();
  app = buildApp(db, { transport, hub, photosDir });
});

// ───────────────────────── Fotos ─────────────────────────
describe("fotos de platillos", () => {
  it("sube, sirve, reemplaza (borrando la anterior) y quita la foto", async () => {
    const t = await admin();
    const id = await prod(t, "Hamburguesa clásica");
    const up = await c(t, "POST", `/api/products/${id}/photo`, { data: jpeg() });
    expect(up.status).toBe(200);
    const file = up.body.photo as string;
    expect(file).toMatch(/^[a-f0-9]{24}-[a-f0-9]{8}\.jpg$/);

    // se sirve sin sesión (el menú QR la muestra a los clientes), con caché
    const get = await app.inject({ method: "GET", url: `/api/photos/${file}` });
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toBe("image/jpeg");
    expect(String(get.headers["cache-control"])).toContain("immutable");
    expect(
      ((await c(t, "GET", "/api/products")).body as { id: string; photo: string }[]).find(
        (p) => p.id === id,
      )!.photo,
    ).toBe(file);

    const again = (await c(t, "POST", `/api/products/${id}/photo`, { data: jpeg(900) })).body
      .photo as string;
    expect(again).not.toBe(file);
    expect(existsSync(join(photosDir, file))).toBe(false); // la anterior se borra
    expect(existsSync(join(photosDir, again))).toBe(true);

    expect((await c(t, "DELETE", `/api/products/${id}/photo`)).status).toBe(200);
    expect(existsSync(join(photosDir, again))).toBe(false);
    expect(readdirSync(photosDir).filter((f) => f.startsWith(id))).toHaveLength(0);
  });

  it("rechaza archivos que no son imágenes, tipos no permitidos y fotos demasiado pesadas", async () => {
    const t = await admin();
    const id = await prod(t, "Ensalada");
    const fake = `data:image/jpeg;base64,${Buffer.from("esto no es una imagen, es un texto cualquiera. ".repeat(5)).toString("base64")}`;
    expect((await c(t, "POST", `/api/products/${id}/photo`, { data: fake })).body.error).toBe(
      "formato_invalido",
    );
    expect(
      (
        await c(t, "POST", `/api/products/${id}/photo`, {
          data: `data:text/html;base64,${Buffer.from("<script>x</script>".repeat(10)).toString("base64")}`,
        })
      ).body.error,
    ).toBe("formato_invalido");
    expect(
      (
        await c(t, "POST", `/api/products/${id}/photo`, {
          data: `data:image/svg+xml;base64,${Buffer.from("<svg onload=alert(1)/>".repeat(10)).toString("base64")}`,
        })
      ).status,
    ).toBe(400);
    expect(
      (await c(t, "POST", `/api/products/${id}/photo`, { data: jpeg(900 * 1024) })).status,
    ).toBe(413);
  });

  it("no permite recorrer carpetas ni que un mesero cambie fotos", async () => {
    const t = await admin();
    const juan = await pin("Juan", "1111");
    const id = await prod(t, "Ensalada");
    expect(
      (await c(juan.token, "POST", `/api/products/${id}/photo`, { data: jpeg() })).status,
    ).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: "/api/photos/..%2F003.sqlite" })).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/photos/nada.jpg" })).statusCode).toBe(404);
  });

  it("el menú QR público incluye la foto del producto", async () => {
    const t = await admin();
    const id = await prod(t, "Margarita");
    const file = (await c(t, "POST", `/api/products/${id}/photo`, { data: jpeg() })).body
      .photo as string;
    const tbl = await tableId(t, "1");
    const qr = (await c(t, "GET", `/api/tables/${tbl}/qr`)).body.path as string;
    const menu = (
      await app.inject({
        method: "GET",
        url: `/api/public/menu?t=${new URL(qr, "http://x").searchParams.get("t")}`,
      })
    ).json();
    expect(menu.products.find((p: { id: string }) => p.id === id).photo).toBe(file);
  });
});

// ───────────────────────── Favoritos ─────────────────────────
describe("favoritos del mesero", () => {
  it("los más pedidos suben solos y se pueden fijar a mano", async () => {
    const t = await admin();
    const juan = await pin("Juan", "1111");
    const acc = await open(juan.token);
    const burger = await prod(t, "Hamburguesa clásica");
    const marg = await prod(t, "Margarita");
    const ens = await prod(t, "Ensalada");
    await c(juan.token, "POST", `/api/accounts/${acc}/orders`, {
      items: [
        { productId: marg, quantity: 5 },
        { productId: burger, quantity: 2 },
        { productId: ens },
      ],
    });
    const fav = (await c(juan.token, "GET", "/api/favorites")).body as {
      product_id: string;
      uses: number;
      pinned: number;
    }[];
    expect(fav.map((f) => f.product_id)).toEqual([marg, burger, ens]);
    expect(fav[0]).toMatchObject({ uses: 5, pinned: 0 });

    await c(juan.token, "POST", `/api/favorites/${ens}/pin`, { pinned: true });
    expect(
      ((await c(juan.token, "GET", "/api/favorites")).body as { product_id: string }[])[0]!
        .product_id,
    ).toBe(ens); // fijado primero
    // son personales: Pedro no ve los de Juan
    const pedro = await pin("Pedro", "2222");
    expect((await c(pedro.token, "GET", "/api/favorites")).body).toEqual([]);
  });
});

// ───────────────────────── Asientos ─────────────────────────
describe("asientos", () => {
  it("el asiento se guarda y sale en la comanda", async () => {
    const t = await admin();
    const juan = await pin("Juan", "1111");
    const acc = await open(juan.token);
    await c(juan.token, "POST", `/api/accounts/${acc}/orders`, {
      items: [{ productId: await prod(t, "Hamburguesa clásica"), seat: 2 }],
    });
    await processQueue(db, transport, hub);
    expect(transport.sent.find((x) => x.host === "192.168.1.50")!.text).toContain("(A2)");
    expect(await db.prepare("SELECT seat FROM order_items").get()).toEqual({ seat: 2 });
    expect(
      (
        await c(juan.token, "POST", `/api/accounts/${acc}/orders`, {
          items: [{ productId: await prod(t, "Ensalada"), seat: 99 }],
        })
      ).status,
    ).toBe(400);
  });
});

// ───────────────────────── Hold & fire ─────────────────────────
describe("tiempos retenidos (hold & fire)", () => {
  it("lo retenido no se produce ni descuenta inventario hasta que se dispara; luego sale con su título", async () => {
    const t = await admin();
    const item = (await c(t, "POST", "/api/inventory/items", { name: "Carne", unit: "g" })).body
      .id as string;
    await c(t, "POST", "/api/inventory/movements", {
      itemId: item,
      kind: "entrada",
      quantity: 1000,
      unit_cost_cents: 1,
    });
    const burger = await prod(t, "Hamburguesa clásica");
    await c(t, "PUT", `/api/recipes/${burger}`, { lines: [{ itemId: item, quantity: 200 }] });

    const juan = await pin("Juan", "1111");
    const acc = await open(juan.token);
    const marg = await prod(t, "Margarita");
    await c(juan.token, "POST", `/api/accounts/${acc}/orders`, {
      items: [
        { productId: marg, course: "Para empezar" },
        { productId: burger, course: "Plato fuerte", hold: true },
      ],
    });

    // solo la bebida llegó a producción
    expect(
      await db
        .prepare("SELECT s.name FROM production_tickets pt JOIN stations s ON s.id=pt.station_id")
        .all(),
    ).toEqual([{ name: "Barra" }]);
    expect(
      (
        (await db.prepare("SELECT stock FROM inventory_items WHERE id=?").get(item)) as {
          stock: number;
        }
      ).stock,
    ).toBe(1000);
    const detail = (await c(juan.token, "GET", `/api/accounts/${acc}`)).body;
    expect(detail.items.find((i: { name: string }) => i.name === "Hamburguesa clásica").held).toBe(
      1,
    );
    expect(detail.total_cents).toBe(8900 + 14900); // lo retenido ya cuenta en la cuenta

    // el pase avisa que hay un tiempo retenido
    const pass = (await c(juan.token, "GET", "/api/pass")).body as {
      held: { course: string; n: number }[];
    }[];
    expect(pass[0]!.held).toEqual([{ course: "Plato fuerte", n: 1 }]);

    await processQueue(db, transport, hub);
    transport.sent.length = 0;
    const fire = await c(juan.token, "POST", `/api/accounts/${acc}/fire`, {
      course: "Plato fuerte",
    });
    expect(fire.body).toMatchObject({ ok: true, fired: 1 });
    expect(await db.prepare("SELECT COUNT(*) c FROM production_tickets").get()).toEqual({ c: 2 });
    expect(
      (
        (await db.prepare("SELECT stock FROM inventory_items WHERE id=?").get(item)) as {
          stock: number;
        }
      ).stock,
    ).toBe(800);
    await processQueue(db, transport, hub);
    const cocina = transport.sent.find((x) => x.host === "192.168.1.50")!;
    expect(cocina.text).toContain("SALE: Plato fuerte");
    expect(cocina.text).toContain("Hamburguesa");
    expect(
      await db.prepare("SELECT held FROM order_items WHERE name='Hamburguesa clásica'").get(),
    ).toEqual({ held: 0 });

    // ya no queda nada retenido
    expect((await c(juan.token, "POST", `/api/accounts/${acc}/fire`, {})).status).toBe(404);
  });

  it("cancelar un producto retenido no pide autorización ni toca inventario; solo se retiene un tiempo con nombre", async () => {
    const t = await admin();
    const juan = await pin("Juan", "1111");
    const acc = await open(juan.token);
    const burger = await prod(t, "Hamburguesa clásica");
    await c(juan.token, "POST", `/api/accounts/${acc}/orders`, {
      items: [
        { productId: burger, course: "Postre", hold: true },
        { productId: burger, hold: true },
      ],
    });
    // el que no tiene nombre de tiempo no se retiene: sale de inmediato
    expect(await db.prepare("SELECT COUNT(*) c FROM production_tickets").get()).toEqual({ c: 1 });
    const held = (
      (await c(juan.token, "GET", `/api/accounts/${acc}`)).body.items as {
        id: string;
        held: number;
      }[]
    ).find((i) => i.held)!;
    const r = await c(juan.token, "POST", `/api/items/${held.id}/cancel`, {
      reason: "Cliente canceló",
    });
    expect(r.body).toMatchObject({ ok: true, afterProduction: false });
    expect((await c(juan.token, "POST", `/api/accounts/${acc}/fire`, {})).status).toBe(404);
  });
});

// ───────────────────────── Pase y recuperar ─────────────────────────
describe("pantalla de pase", () => {
  it("agrupa por mesa lo que está en producción, avisa cuándo todo está listo y permite recuperar un ticket", async () => {
    const t = await admin();
    const juan = await pin("Juan", "1111");
    const acc = await open(juan.token, "3");
    await c(juan.token, "POST", `/api/accounts/${acc}/orders`, {
      items: [
        { productId: await prod(t, "Hamburguesa clásica") },
        { productId: await prod(t, "Margarita") },
      ],
    });
    let pass = (await c(t, "GET", "/api/pass")).body as {
      label: string;
      ready: boolean;
      tickets: { id: string; status: string; station: string }[];
    }[];
    expect(pass).toHaveLength(1);
    expect(pass[0]).toMatchObject({ label: "3", ready: false });
    expect(pass[0]!.tickets.map((x) => x.station).sort()).toEqual([
      "Bar / Coctelería",
      "Cocina / Calientes",
    ]);

    for (const tk of pass[0]!.tickets) {
      await c(t, "POST", `/api/tickets/${tk.id}/status`, { status: "preparando" });
      await c(t, "POST", `/api/tickets/${tk.id}/status`, { status: "listo" });
    }
    pass = (await c(t, "GET", "/api/pass")).body as typeof pass;
    expect(pass[0]!.ready).toBe(true);

    const tk = pass[0]!.tickets[0]!.id;
    await c(juan.token, "POST", `/api/tickets/${tk}/status`, { status: "entregado" });
    expect((await c(t, "POST", `/api/tickets/${tk}/recall`)).body).toMatchObject({
      status: "listo",
    });
    expect((await c(t, "POST", `/api/tickets/${tk}/recall`)).body).toMatchObject({
      status: "preparando",
    });
    expect((await c(t, "POST", `/api/tickets/${tk}/recall`)).status).toBe(409); // preparando no se recupera
    expect((await c(juan.token, "POST", `/api/tickets/${tk}/recall`)).status).toBe(403); // el mesero no
  });
});

// ───────────────────────── Cobro por partes y por asiento ─────────────────────────
describe("cobro en partes iguales y por asiento", () => {
  async function setup(items: { name: string; seat?: number }[]) {
    const t = await admin();
    const juan = await pin("Juan", "1111");
    const caja = await pin("Caja", "3333");
    await c(caja.token, "POST", "/api/cash/open", { opening_cents: 0 });
    const acc = await open(juan.token, "1", 4);
    await c(juan.token, "POST", `/api/accounts/${acc}/orders`, {
      items: await Promise.all(
        items.map(async (i) => ({ productId: await prod(t, i.name), seat: i.seat })),
      ),
    });
    return { t, juan, caja, acc };
  }
  const pay = (token: string, acc: string, body: object) =>
    c(token, "POST", `/api/accounts/${acc}/payments`, { idempotencyKey: key(), ...body });

  it("tres partes iguales: cada pago cubre su parte, el último cierra la cuenta y la mesa se libera", async () => {
    const t = await admin();
    const station = (
      (await db.prepare("SELECT id FROM stations WHERE name='Plancha'").get()) as { id: string }
    ).id;
    await c(t, "POST", "/api/products", {
      name: "Prueba centavos",
      price_cents: 10001,
      station_ids: [station],
    });
    const { juan, caja, acc } = await setup([{ name: "Prueba centavos" }]);

    const shares = [3334, 3334, 3333]; // suman 10001: el último absorbe el centavo
    const r1 = await pay(caja.token, acc, {
      cover_cents: shares[0],
      lines: [{ method: "efectivo", amount_cents: 4000 }],
    });
    expect(r1.body).toMatchObject({
      covered_cents: 3334,
      change_cents: 666,
      balance_cents: 6667,
      closed: false,
    });
    expect((await c(juan.token, "GET", `/api/accounts/${acc}`)).body).toMatchObject({
      status: "abierta",
      paid_cents: 3334,
      balance_cents: 6667,
    });
    const floor = (await c(juan.token, "GET", "/api/floor")).body as {
      number: string;
      status: string;
      accounts: { paid_cents: number }[];
    }[];
    expect(floor.find((x) => x.number === "1")).toMatchObject({ status: "ocupada" });
    expect(floor.find((x) => x.number === "1")!.accounts[0]!.paid_cents).toBe(3334);

    await pay(caja.token, acc, {
      cover_cents: shares[1],
      lines: [{ method: "tarjeta", amount_cents: 3334 }],
    });
    const last = await pay(caja.token, acc, {
      lines: [{ method: "efectivo", amount_cents: 3333 }],
    }); // sin cover: el saldo
    expect(last.body).toMatchObject({ covered_cents: 3333, balance_cents: 0, closed: true });
    expect(
      (
        (await c(juan.token, "GET", "/api/floor")).body as { number: string; status: string }[]
      ).find((x) => x.number === "1")!.status,
    ).toBe("disponible");

    // la caja cuadra con lo realmente cobrado: efectivo 3334+3333, tarjeta 3334
    const sum = (await c(caja.token, "GET", "/api/cash/current")).body.summary;
    expect(sum.by_method).toEqual({ efectivo: 6667, tarjeta: 3334 });
    expect(sum.sales_cents).toBe(10001);
    // varias pagos de una cuenta cuentan como UNA venta en los reportes
    const rep = (await c(t, "GET", "/api/reports/sales")).body;
    expect(rep).toMatchObject({ tickets: 1, sales_cents: 10001 });
  });

  it("no deja cobrar más que el saldo ni menos que lo que cubre el pago", async () => {
    const { caja, acc } = await setup([{ name: "Hamburguesa clásica" }]);
    expect(
      (
        await pay(caja.token, acc, {
          cover_cents: 20000,
          lines: [{ method: "efectivo", amount_cents: 20000 }],
        })
      ).body.error,
    ).toBe("excede_saldo");
    expect(
      (
        await pay(caja.token, acc, {
          cover_cents: 5000,
          lines: [{ method: "efectivo", amount_cents: 4000 }],
        })
      ).body.error,
    ).toBe("pago_insuficiente");
    expect(
      (
        await pay(caja.token, acc, {
          cover_cents: 5000,
          lines: [{ method: "tarjeta", amount_cents: 6000 }],
        })
      ).body.error,
    ).toBe("pago_excedido");
  });

  it("por asiento: calcula lo que le toca a cada uno, marca los que ya pagaron y cierra con el último", async () => {
    const { juan, caja, acc } = await setup([
      { name: "Hamburguesa clásica", seat: 1 },
      { name: "Margarita", seat: 2 },
    ]);
    // un descuento se reparte proporcionalmente entre los asientos
    await c(juan.token, "POST", `/api/accounts/${acc}/discounts`, {
      kind: "monto",
      value: 2000,
      reason: "Cortesía",
    });
    const bal = (await c(juan.token, "GET", `/api/accounts/${acc}/balance`)).body;
    expect(bal.total_cents).toBe(23800 - 2000);
    expect(bal.seats.map((s: { seat: number }) => s.seat)).toEqual([1, 2]);
    expect(bal.seats.reduce((s: number, x: { share_cents: number }) => s + x.share_cents, 0)).toBe(
      21800,
    ); // la suma es exacta
    expect(bal.seats[0].share_cents).toBeGreaterThan(bal.seats[1].share_cents);

    await pay(caja.token, acc, {
      cover_cents: bal.seats[0].share_cents,
      seat: 1,
      lines: [{ method: "efectivo", amount_cents: bal.seats[0].share_cents }],
    });
    const after = (await c(juan.token, "GET", `/api/accounts/${acc}/balance`)).body;
    expect(after.seats.map((s: { paid: boolean }) => s.paid)).toEqual([true, false]);
    expect(after.balance_cents).toBe(bal.seats[1].share_cents);
    const last = await pay(caja.token, acc, {
      seat: 2,
      lines: [{ method: "tarjeta", amount_cents: after.balance_cents }],
    });
    expect(last.body.closed).toBe(true);
  });

  it("el cobro parcial imprime lo cubierto y el saldo pendiente; la factura usa el total de todos los pagos", async () => {
    const { t, caja, acc } = await setup([{ name: "Hamburguesa clásica" }]);
    await pay(caja.token, acc, {
      cover_cents: 5000,
      lines: [{ method: "efectivo", amount_cents: 5000 }],
    });
    await processQueue(db, transport, hub);
    const ticket = transport.sent
      .filter((x) => x.host === "192.168.1.53")
      .map((x) => x.text)
      .join("\n");
    expect(ticket).toContain("Pago parcial");
    expect(ticket).toContain("Saldo pendiente");

    await c(t, "PUT", "/api/settings", {
      fiscal_rfc: "EKU9003173C9",
      fiscal_name: "Demo SA",
      fiscal_regimen: "601",
      fiscal_cp: "64000",
    });
    const fiscal = {
      rfc: "XAXX010101000",
      razon_social: "Cliente",
      regimen_fiscal: "616",
      cp: "64000",
      uso_cfdi: "S01",
    };
    expect((await c(t, "POST", `/api/accounts/${acc}/invoice`, { fiscal })).status).toBe(409); // aún abierta
    await pay(caja.token, acc, { lines: [{ method: "tarjeta", amount_cents: 9900 }] });
    const inv = await c(t, "POST", `/api/accounts/${acc}/invoice`, { fiscal });
    expect(inv.body).toMatchObject({ total_cents: 14900 });
    expect((await c(t, "GET", `/api/invoices/${inv.body.id}/xml`)).body).toContain(
      'FormaPago="99"',
    ); // efectivo + tarjeta → por definir
  });
});

// ───────────────────────── Cargo por servicio ─────────────────────────
describe("cargo por servicio", () => {
  it("se aplica solo desde N personas, entra al total y a la cuenta impresa, y un gerente puede dispensarlo", async () => {
    const t = await admin();
    expect(
      (await c(t, "PUT", "/api/settings", { service_charge_pct: 10, service_charge_min_guests: 4 }))
        .status,
    ).toBe(200);
    expect((await c(t, "PUT", "/api/settings", { service_charge_pct: 80 })).status).toBe(400);
    const juan = await pin("Juan", "1111");
    const burger = await prod(t, "Hamburguesa clásica");

    const small = await open(juan.token, "1", 2);
    await c(juan.token, "POST", `/api/accounts/${small}/orders`, {
      items: [{ productId: burger }],
    });
    expect((await c(juan.token, "GET", `/api/accounts/${small}`)).body).toMatchObject({
      service_charge_cents: 0,
      total_cents: 14900,
    });

    const big = await open(juan.token, "2", 5);
    await c(juan.token, "POST", `/api/accounts/${big}/orders`, { items: [{ productId: burger }] });
    expect((await c(juan.token, "GET", `/api/accounts/${big}`)).body).toMatchObject({
      service_charge_cents: 1490,
      total_cents: 16390,
    });
    // el servicio se calcula sobre la cuenta ya con descuento
    await c(juan.token, "POST", `/api/accounts/${big}/discounts`, {
      kind: "monto",
      value: 900,
      reason: "Cortesía",
    });
    expect((await c(juan.token, "GET", `/api/accounts/${big}`)).body).toMatchObject({
      service_charge_cents: 1400,
      total_cents: 15400,
    });

    await c(juan.token, "POST", `/api/accounts/${big}/request-bill`);
    await processQueue(db, transport, hub);
    expect(
      transport.sent
        .filter((x) => x.host === "192.168.1.53")
        .map((x) => x.text)
        .join("\n"),
    ).toContain("Servicio 10%");

    expect(
      (await c(juan.token, "POST", `/api/accounts/${big}/service-charge`, { waive: true })).status,
    ).toBe(403);
    expect(
      (await c(t, "POST", `/api/accounts/${big}/service-charge`, { waive: true })).status,
    ).toBe(200);
    expect((await c(juan.token, "GET", `/api/accounts/${big}`)).body).toMatchObject({
      service_charge_cents: 0,
      total_cents: 14000,
    });
  });

  it("el servicio se cobra y se factura como un concepto aparte", async () => {
    const t = await admin();
    await c(t, "PUT", "/api/settings", {
      service_charge_pct: 10,
      service_charge_min_guests: 1,
      fiscal_rfc: "EKU9003173C9",
      fiscal_name: "Demo SA",
      fiscal_regimen: "601",
      fiscal_cp: "64000",
    });
    const juan = await pin("Juan", "1111");
    const caja = await pin("Caja", "3333");
    await c(caja.token, "POST", "/api/cash/open", { opening_cents: 0 });
    const acc = await open(juan.token);
    await c(juan.token, "POST", `/api/accounts/${acc}/orders`, {
      items: [{ productId: await prod(t, "Hamburguesa clásica") }],
    });
    expect(
      (
        await c(caja.token, "POST", `/api/accounts/${acc}/payments`, {
          idempotencyKey: key(),
          lines: [{ method: "tarjeta", amount_cents: 16390 }],
        })
      ).status,
    ).toBe(201);
    const inv = await c(t, "POST", `/api/accounts/${acc}/invoice`, {
      fiscal: {
        rfc: "XAXX010101000",
        razon_social: "Cliente",
        regimen_fiscal: "616",
        cp: "64000",
        uso_cfdi: "S01",
      },
    });
    const xml = (await c(t, "GET", `/api/invoices/${inv.body.id}/xml`)).body as string;
    expect(xml).toContain("Cargo por servicio");
    expect(xml).toContain('Total="163.90"');
    expect(xml.match(/<cfdi:Concepto /g)).toHaveLength(2);
  });
});

// ───────────────────────── Checador y propinas ─────────────────────────
describe("checador de personal", () => {
  it("registra entrada y salida, no permite duplicar y un administrador cierra turnos olvidados", async () => {
    const t = await admin();
    const juan = await pin("Juan", "1111");
    expect((await c(juan.token, "GET", "/api/clock/status")).body).toMatchObject({
      on_shift: false,
    });
    expect((await c(juan.token, "POST", "/api/clock/in")).status).toBe(201);
    expect((await c(juan.token, "POST", "/api/clock/in")).body.error).toBe("ya_en_turno");
    expect((await c(juan.token, "GET", "/api/clock/status")).body.on_shift).toBe(true);
    expect((await c(juan.token, "POST", "/api/clock/out")).status).toBe(200);
    expect((await c(juan.token, "POST", "/api/clock/out")).body.error).toBe("sin_turno");

    const pedro = await pin("Pedro", "2222");
    await c(pedro.token, "POST", "/api/clock/in");
    expect((await c(juan.token, "POST", `/api/clock/${pedro.id}/out`)).status).toBe(403);
    expect((await c(t, "POST", `/api/clock/${pedro.id}/out`)).status).toBe(200);
  });

  it("el reporte suma las horas por persona recortadas al periodo y marca a quien sigue en turno", async () => {
    const t = await admin();
    const juan = await pin("Juan", "1111");
    const H = 3_600_000;
    const now = Date.now();
    await db
      .prepare("INSERT INTO time_entries (id,user_id,clock_in,clock_out) VALUES ('a',?,?,?)")
      .run(juan.id, now - 10 * H, now - 6 * H); // 4 h
    await db
      .prepare("INSERT INTO time_entries (id,user_id,clock_in,clock_out) VALUES ('b',?,?,NULL)")
      .run(juan.id, now - 2 * H); // abierto, 2 h
    const rep = (await c(t, "GET", `/api/clock/report?from=${now - 8 * H}&to=${now}`)).body as {
      name: string;
      hours: number;
      shifts: number;
      on_shift: boolean;
    }[];
    const j = rep.find((r) => r.name === "Juan")!;
    expect(j.shifts).toBe(2);
    expect(j.on_shift).toBe(true);
    expect(j.hours).toBeCloseTo(2 + 2, 1); // del primer turno solo cuentan 2 h dentro del periodo
    expect((await c(juan.token, "GET", "/api/clock/report")).status).toBe(403);
  });
});

describe("reparto de propinas", () => {
  it("nunca pierde ni inventa centavos", () => {
    const parts = splitByWeight(10001, { a: 1, b: 1, c: 1 });
    expect(Object.values(parts).reduce((s, v) => s + v, 0)).toBe(10001);
    expect(
      Math.max(...Object.values(parts)) - Math.min(...Object.values(parts)),
    ).toBeLessThanOrEqual(1);
    for (const [amount, w] of [
      [1, { a: 3, b: 2 }],
      [99999, { x: 7, y: 11, z: 13 }],
      [5, { a: 1, b: 0 }],
    ] as const) {
      const got = splitByWeight(amount, w);
      expect(Object.values(got).reduce((s, v) => s + v, 0)).toBe(amount);
    }
  });

  it("política individual: cada mesero conserva lo suyo menos su aporte, que va al personal de apoyo por horas", () => {
    const r = distributeTips({
      policy: "individual",
      supportPct: 20,
      roles: { mesero: 60, cocina: 25, bar: 15 },
      tipsByWaiter: { juan: 10000, pedro: 5000 },
      staff: [
        { id: "juan", role: "mesero", hours: 8 },
        { id: "chef1", role: "cocina", hours: 6 },
        { id: "chef2", role: "cocina", hours: 2 },
        { id: "barman", role: "bar", hours: 8 },
      ],
    });
    expect(r.payouts.juan).toBe(8000);
    expect(r.payouts.pedro).toBe(4000);
    // aporte total 3000: cocina 25/(25+15) = 1875, bar 1125; cocina por horas 6:2
    expect(r.payouts.barman).toBe(1125);
    expect(r.payouts.chef1! + r.payouts.chef2!).toBe(1875);
    expect(r.payouts.chef1).toBe(1406);
    expect(r.unassignedCents).toBe(0);
  });

  it("política individual sin personal de apoyo: el aporte regresa a los meseros", () => {
    const r = distributeTips({
      policy: "individual",
      supportPct: 50,
      roles: { mesero: 100, cocina: 50 },
      tipsByWaiter: { a: 1000, b: 3000 },
      staff: [],
    });
    expect(r.payouts).toEqual({ a: 1000, b: 3000 });
    expect(r.unassignedCents).toBe(0);
  });

  it("política de fondo común: se reparte por rol y dentro del rol por horas; los roles sin personal no cobran", () => {
    const r = distributeTips({
      policy: "pool",
      supportPct: 0,
      roles: { mesero: 60, cocina: 30, bar: 10 },
      tipsByWaiter: { juan: 7000, pedro: 3000 },
      staff: [
        { id: "juan", role: "mesero", hours: 6 },
        { id: "pedro", role: "mesero", hours: 2 },
        { id: "chef", role: "cocina", hours: 8 },
      ],
    });
    // total 10000; bar no tiene personal → mesero 60/90, cocina 30/90
    expect(r.payouts.chef).toBe(3333);
    expect(r.payouts.juan! + r.payouts.pedro!).toBe(6667);
    expect(r.payouts.juan).toBe(5000);
    expect(Object.values(r.payouts).reduce((s, v) => s + v, 0)).toBe(10000);
    expect(r.unassignedCents).toBe(0);
  });

  it("el reporte por API usa las propinas de las cuentas de cada mesero y las horas del checador", async () => {
    const t = await admin();
    const juan = await pin("Juan", "1111");
    const caja = await pin("Caja", "3333");
    await c(t, "POST", "/api/users", { name: "Chef", role: "cocina", pin: "4444" });
    const chef = await pin("Chef", "4444");
    await c(caja.token, "POST", "/api/cash/open", { opening_cents: 0 });
    const acc = await open(juan.token);
    await c(juan.token, "POST", `/api/accounts/${acc}/orders`, {
      items: [{ productId: await prod(t, "Hamburguesa clásica") }],
    });
    await c(caja.token, "POST", `/api/accounts/${acc}/payments`, {
      idempotencyKey: key(),
      lines: [{ method: "tarjeta", amount_cents: 14900 }],
      tip_cents: 2000,
      tip_method: "tarjeta",
    });
    const H = 3_600_000;
    const now = Date.now();
    await db
      .prepare("INSERT INTO time_entries (id,user_id,clock_in,clock_out) VALUES ('j',?,?,?)")
      .run(juan.id, now - 4 * H, now - H);
    await db
      .prepare("INSERT INTO time_entries (id,user_id,clock_in,clock_out) VALUES ('k',?,?,?)")
      .run(chef.id, now - 4 * H, now - H);

    await c(t, "PUT", "/api/settings", { tip_policy: "individual", tip_support_pct: 25 });
    const range = `?from=${now - 6 * H}&to=${now + 60_000}`; // rango explícito: no depende de la hora del día en que corra la prueba
    let rep = (await c(t, "GET", `/api/tips/report${range}`)).body;
    expect(rep).toMatchObject({ policy: "individual", total_cents: 2000, unassigned_cents: 0 });
    expect(rep.payouts.find((p: { name: string }) => p.name === "Juan").amount_cents).toBe(1500);
    expect(rep.payouts.find((p: { name: string }) => p.name === "Chef").amount_cents).toBe(500);

    await c(t, "PUT", "/api/settings", {
      tip_policy: "pool",
      tip_roles: JSON.stringify({ mesero: 50, cocina: 50 }),
    });
    rep = (await c(t, "GET", `/api/tips/report${range}`)).body;
    expect(rep.payouts.map((p: { amount_cents: number }) => p.amount_cents)).toEqual([1000, 1000]);
    expect((await c(juan.token, "GET", "/api/tips/report")).status).toBe(403);
    expect((await c(t, "PUT", "/api/settings", { tip_roles: "no es json" })).status).toBe(400);
  });
});

// ───────────────────────── Tarjetas de regalo ─────────────────────────
describe("tarjetas de regalo", () => {
  async function ready() {
    const t = await admin();
    const juan = await pin("Juan", "1111");
    const caja = await pin("Caja", "3333");
    return { t, juan, caja };
  }

  it("se venden en caja (el efectivo entra a la caja, no a las ventas) y se canjean como pago, también combinadas", async () => {
    const { t, juan, caja } = await ready();
    expect(
      (await c(caja.token, "POST", "/api/gift-cards", { amount_cents: 50000, method: "efectivo" }))
        .body.error,
    ).toBe("caja_cerrada");
    await c(caja.token, "POST", "/api/cash/open", { opening_cents: 100000 });
    const sold = await c(caja.token, "POST", "/api/gift-cards", {
      amount_cents: 50000,
      method: "efectivo",
    });
    expect(sold.status).toBe(201);
    const code = sold.body.code as string;
    expect(code).toMatch(/^GC-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

    let sum = (await c(caja.token, "GET", "/api/cash/current")).body.summary;
    expect(sum).toMatchObject({
      incomes_cents: 50000,
      sales_cents: 0,
      expected_cash_cents: 150000,
    });

    const acc = await open(juan.token);
    await c(juan.token, "POST", `/api/accounts/${acc}/orders`, {
      items: [
        { productId: await prod(t, "Hamburguesa clásica") },
        { productId: await prod(t, "Margarita") },
      ],
    }); // 23800
    const paid = await c(caja.token, "POST", `/api/accounts/${acc}/payments`, {
      idempotencyKey: key(),
      lines: [
        { method: "regalo", amount_cents: 20000, reference: code.toLowerCase() },
        { method: "efectivo", amount_cents: 3800 },
      ],
    });
    expect(paid.body).toMatchObject({ closed: true, change_cents: 0 });
    expect((await c(caja.token, "GET", `/api/gift-cards/${code}`)).body).toMatchObject({
      balance_cents: 30000,
      status: "activa",
    });

    sum = (await c(caja.token, "GET", "/api/cash/current")).body.summary;
    expect(sum.by_method).toEqual({ regalo: 20000, efectivo: 3800 });
    expect(sum.expected_cash_cents).toBe(100000 + 3800 + 50000); // la tarjeta de regalo no suma al efectivo esperado por ventas

    const rep = (await c(t, "GET", "/api/gift-cards")).body;
    expect(rep).toMatchObject({
      sold_cents: 50000,
      redeemed_cents: 20000,
      outstanding_cents: 30000,
    });
  });

  it("valida código, saldo y estado; al agotarse queda 'agotada' y no se puede cancelar sin autorización", async () => {
    const { t, juan, caja } = await ready();
    await c(caja.token, "POST", "/api/cash/open", { opening_cents: 0 });
    const code = (
      await c(caja.token, "POST", "/api/gift-cards", { amount_cents: 10000, method: "tarjeta" })
    ).body.code as string;
    const acc = await open(juan.token);
    await c(juan.token, "POST", `/api/accounts/${acc}/orders`, {
      items: [{ productId: await prod(t, "Hamburguesa clásica") }],
    }); // 14900
    const gift = (amount: number, reference?: string) =>
      c(caja.token, "POST", `/api/accounts/${acc}/payments`, {
        idempotencyKey: key(),
        cover_cents: amount,
        lines: [{ method: "regalo", amount_cents: amount, reference }],
      });

    expect((await gift(5000)).body.error).toBe("tarjeta_requerida");
    expect((await gift(5000, "GC-ZZZZ-ZZZZ")).body.error).toBe("tarjeta_no_encontrada");
    expect((await gift(12000, code)).body.error).toBe("saldo_insuficiente");
    expect((await gift(10000, code)).status).toBe(201); // queda en cero
    expect((await c(caja.token, "GET", `/api/gift-cards/${code}`)).body.status).toBe("agotada");
    expect((await gift(1000, code)).body.error).toBe("tarjeta_inactiva");

    const other = (
      await c(caja.token, "POST", "/api/gift-cards", {
        amount_cents: 20000,
        method: "transferencia",
      })
    ).body.code as string;
    expect((await c(caja.token, "POST", `/api/gift-cards/${other}/cancel`)).status).toBe(403); // el cajero no cancela
    expect((await c(t, "POST", `/api/gift-cards/${other}/cancel`)).body).toMatchObject({
      ok: true,
      balance_cents: 20000,
    });
    expect((await gift(1000, other)).body.error).toBe("tarjeta_inactiva");
  });

  it("canjear con la misma clave de cobro no descuenta dos veces", async () => {
    const { t, juan, caja } = await ready();
    await c(caja.token, "POST", "/api/cash/open", { opening_cents: 0 });
    const code = (
      await c(caja.token, "POST", "/api/gift-cards", { amount_cents: 20000, method: "efectivo" })
    ).body.code as string;
    const acc = await open(juan.token);
    await c(juan.token, "POST", `/api/accounts/${acc}/orders`, {
      items: [{ productId: await prod(t, "Ensalada") }],
    }); // 9900
    const body = {
      idempotencyKey: "misma-clave-0001",
      cover_cents: 5000,
      lines: [{ method: "regalo", amount_cents: 5000, reference: code }],
    };
    expect((await c(caja.token, "POST", `/api/accounts/${acc}/payments`, body)).status).toBe(201);
    expect(
      (await c(caja.token, "POST", `/api/accounts/${acc}/payments`, body)).body.duplicate,
    ).toBe(true);
    expect((await c(caja.token, "GET", `/api/gift-cards/${code}`)).body.balance_cents).toBe(15000);
  });
});

describe("foto del personal", () => {
  it("se sube, aparece en la lista pública de acceso y exige permiso", async () => {
    const t = await admin();
    const users = (await c(t, "GET", "/api/users")).body as { id: string; name: string }[];
    const juan = users.find((u) => u.name === "Juan")!;
    const up = await c(t, "POST", `/api/users/${juan.id}/photo`, { data: jpeg() });
    expect(up.status).toBe(200);
    expect(existsSync(join(photosDir, up.body.photo))).toBe(true);

    // la pantalla de acceso (sin sesión) ya trae la foto
    const pub = (await app.inject({ method: "GET", url: "/api/auth/users" })).json() as {
      id: string;
      photo: string | null;
    }[];
    expect(pub.find((u) => u.id === juan.id)!.photo).toBe(up.body.photo);

    // un mesero no puede cambiarla
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/pin",
      payload: { userId: juan.id, pin: "1111" },
    });
    expect(
      (await c(login.json().token, "POST", `/api/users/${juan.id}/photo`, { data: jpeg() })).status,
    ).toBe(403);

    expect((await c(t, "DELETE", `/api/users/${juan.id}/photo`)).status).toBe(200);
    expect(existsSync(join(photosDir, up.body.photo))).toBe(false);
  });
});
