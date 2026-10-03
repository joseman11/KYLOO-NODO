import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { routeOrder } from "@003/shared";
import { buildApp } from "../src/app";
import { openDb, type Db } from "../src/db";
import { processQueue } from "../src/printing/queue";
import { renderBill, renderComanda, titled } from "../src/printing/render";
import { seed } from "../src/seed";
import { Hub } from "../src/hub";
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

let app: FastifyInstance;
let db: Db;
let transport: FakeTransport;
let hub: Hub;
const H = (t: string) => ({ Authorization: `Bearer ${t}` });
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const call = async (t: string, method: Method, url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers: H(t), payload: payload as object });
  return {
    status: r.statusCode,
    body: r.body && String(r.headers["content-type"]).includes("json") ? r.json() : r.body,
  };
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
  return (
    await app.inject({ method: "POST", url: "/api/auth/pin", payload: { userId: u.id, pin: p } })
  ).json().token as string;
}

beforeEach(async () => {
  db = await openDb(":memory:");
  await seed(db, "admin1234");
  transport = new FakeTransport();
  hub = new Hub();
  app = buildApp(db, { transport, hub });
});

describe("áreas y destino de productos", () => {
  it("el usuario crea un área con estaciones y manda bebidas a barra y comida a cocina en una sola comanda", async () => {
    const t = await admin();
    const bar2 = (await call(t, "POST", "/api/areas", { name: "Terraza bar", kind: "produccion" }))
      .body.id as string;
    const st = await call(t, "POST", `/api/areas/${bar2}/stations`, { name: "Coctelería terraza" });
    expect(st.status).toBe(201);
    expect(
      (await call(t, "POST", `/api/areas/${bar2}/stations`, { name: "coctelería terraza" })).status,
    ).toBe(409); // repetida

    const cocinaSt = (
      (await db.prepare("SELECT id FROM stations WHERE name='Plancha'").get()) as { id: string }
    ).id;
    const barSt = (
      (await db.prepare("SELECT id FROM stations WHERE name='Barra'").get()) as { id: string }
    ).id;
    const mk = async (name: string, stations: string[]) =>
      (await call(t, "POST", "/api/products", { name, price_cents: 5000, station_ids: stations }))
        .body.id as string;
    const coca = await mk("Coca", [barSt]);
    const taco = await mk("Taco", [cocinaSt]);
    const mojito = await mk("Mojito", [st.body.id]);

    const juan = await pin("Juan", "1111");
    const tbl = ((await call(t, "GET", "/api/tables")).body as { id: string }[])[0]!.id;
    const acc = (await call(juan, "POST", `/api/tables/${tbl}/open`, {})).body.id as string;
    await call(juan, "POST", `/api/accounts/${acc}/orders`, {
      items: [{ productId: coca }, { productId: taco }, { productId: mojito }],
    });
    const tickets = await db
      .prepare(
        "SELECT s.name station FROM production_tickets pt JOIN stations s ON s.id=pt.station_id ORDER BY s.name",
      )
      .all();
    expect(tickets).toEqual([
      { station: "Barra" },
      { station: "Coctelería terraza" },
      { station: "Plancha" },
    ]);
  });

  it("no deja borrar un área con estaciones ni una estación con productos", async () => {
    const t = await admin();
    const cocina = (
      (await db.prepare("SELECT id FROM areas WHERE name='Cocina'").get()) as { id: string }
    ).id;
    const r = await call(t, "DELETE", `/api/areas/${cocina}`);
    expect(r.status).toBe(409);
    expect(r.body.message).toContain("estación");
    const plancha = (
      (await db.prepare("SELECT id FROM stations WHERE name='Plancha'").get()) as { id: string }
    ).id;
    expect((await call(t, "DELETE", `/api/stations/${plancha}`)).body.message).toContain(
      "producto",
    );

    const vacia = (await call(t, "POST", "/api/areas", { name: "Vacía", kind: "produccion" })).body
      .id as string;
    expect((await call(t, "DELETE", `/api/areas/${vacia}`)).status).toBe(200);
  });
});

describe("categorías propias", () => {
  it("crea categorías y subcategorías, y el producto nuevo hereda el destino de su categoría", async () => {
    const t = await admin();
    const cocina = (
      (await db.prepare("SELECT id FROM stations WHERE name='Plancha'").get()) as { id: string }
    ).id;
    const barra = (
      (await db.prepare("SELECT id FROM stations WHERE name='Barra'").get()) as { id: string }
    ).id;
    const tacos = (await call(t, "POST", "/api/categories", { name: "Tacos" })).body.id as string;
    const calamar = (
      await call(t, "POST", "/api/categories", { name: "Tacos de calamar", parent_id: tacos })
    ).body.id as string;
    const refrescos = (await call(t, "POST", "/api/categories", { name: "Refrescos" })).body
      .id as string;
    await call(t, "PUT", `/api/categories/${tacos}/routes`, { station_ids: [cocina] });
    await call(t, "PUT", `/api/categories/${refrescos}/routes`, { station_ids: [barra] });

    // sin station_ids: hereda de la categoría (la subcategoría, de su padre)
    const taco = (
      await call(t, "POST", "/api/products", {
        name: "Taco de calamar",
        price_cents: 8000,
        category_id: calamar,
      })
    ).body.id as string;
    const coca = (
      await call(t, "POST", "/api/products", {
        name: "Coca",
        price_cents: 3000,
        category_id: refrescos,
      })
    ).body.id as string;
    const routes = (await call(t, "GET", "/api/products")).body as {
      id: string;
      station_ids: string[];
    }[];
    expect(routes.find((p) => p.id === taco)!.station_ids).toEqual([cocina]);
    expect(routes.find((p) => p.id === coca)!.station_ids).toEqual([barra]);

    // sin categoría ni destino: se rechaza
    expect(
      (await call(t, "POST", "/api/products", { name: "Huérfano", price_cents: 100 })).body.error,
    ).toBe("sin_destino");
  });

  it("reasignar el destino de una categoría actualiza sus productos y subcategorías", async () => {
    const t = await admin();
    const cocina = (
      (await db.prepare("SELECT id FROM stations WHERE name='Plancha'").get()) as { id: string }
    ).id;
    const barra = (
      (await db.prepare("SELECT id FROM stations WHERE name='Barra'").get()) as { id: string }
    ).id;
    const padre = (await call(t, "POST", "/api/categories", { name: "Antojitos" })).body
      .id as string;
    const hija = (await call(t, "POST", "/api/categories", { name: "Garnachas", parent_id: padre }))
      .body.id as string;
    const p1 = (
      await call(t, "POST", "/api/products", {
        name: "Sope",
        price_cents: 4000,
        category_id: hija,
        station_ids: [cocina],
      })
    ).body.id as string;
    const r = await call(t, "PUT", `/api/categories/${padre}/routes`, {
      station_ids: [barra],
      apply_to_products: true,
    });
    expect(r.body.updated_products).toBe(1);
    expect(
      (
        (await call(t, "GET", "/api/products")).body as { id: string; station_ids: string[] }[]
      ).find((p) => p.id === p1)!.station_ids,
    ).toEqual([barra]);
  });

  it("valida ciclos y profundidad, y no borra categorías con productos o subcategorías", async () => {
    const t = await admin();
    const a = (await call(t, "POST", "/api/categories", { name: "A" })).body.id as string;
    const b = (await call(t, "POST", "/api/categories", { name: "B", parent_id: a })).body
      .id as string;
    const c = (await call(t, "POST", "/api/categories", { name: "C", parent_id: b })).body
      .id as string;
    expect((await call(t, "POST", "/api/categories", { name: "D", parent_id: c })).status).toBe(
      400,
    ); // 4º nivel
    expect((await call(t, "PATCH", `/api/categories/${a}`, { parent_id: c })).status).toBe(400); // ciclo
    expect((await call(t, "DELETE", `/api/categories/${a}`)).body.message).toContain(
      "subcategoría",
    );

    const barra = (
      (await db.prepare("SELECT id FROM stations WHERE name='Barra'").get()) as { id: string }
    ).id;
    await call(t, "POST", "/api/products", {
      name: "Algo",
      price_cents: 1,
      category_id: c,
      station_ids: [barra],
    });
    expect((await call(t, "DELETE", `/api/categories/${c}`)).body.message).toContain("producto");
  });
});

describe("separadores en tickets", () => {
  it("el motor de enrutamiento conserva el tiempo de cada producto", () => {
    const route = { area: "Cocina", subarea: "Calientes", stationId: "s1", printerIds: [] };
    const [t] = routeOrder([
      { id: "1", productId: "a", name: "Taco", quantity: 1, course: "Entradas", routes: [route] },
      {
        id: "2",
        productId: "b",
        name: "Arrachera",
        quantity: 1,
        course: "Plato fuerte",
        routes: [route],
      },
      { id: "3", productId: "c", name: "Agua", quantity: 1, routes: [route] },
    ]);
    expect(t!.lines.map((l) => l.course)).toEqual(["Entradas", "Plato fuerte", undefined]);
  });

  it("la comanda imprime un separador al cambiar de tiempo, con el carácter configurado", () => {
    const lines = renderComanda(
      {
        kind: "comanda",
        stationLabel: "Cocina",
        tableNumber: "5",
        waiter: "Juan",
        folio: 1,
        createdAt: 0,
        lines: [
          { quantity: 1, name: "Taco", modifiers: [], course: "Entradas" },
          { quantity: 1, name: "Taco 2", modifiers: [], course: "Entradas" },
          { quantity: 1, name: "Arrachera", modifiers: [], course: "Plato fuerte" },
        ],
      },
      80,
      { sep: "=", groupCategories: false, footer: "" },
    );
    const text = lines.join("\n");
    expect(text.match(/ENTRADAS/g)).toHaveLength(1); // un solo separador por tiempo
    expect(text).toContain("PLATO FUERTE");
    expect(text).toContain("=".repeat(42));
    expect(lines.findIndex((l) => l.includes("ENTRADAS"))).toBeLessThan(
      lines.findIndex((l) => l.includes("Arrachera")),
    );
    expect(titled("Postre", 20, "*")).toBe("****** POSTRE ******");
    expect(titled("Postre", 20, "*")).toHaveLength(20);
  });

  it("la cuenta agrupa por categoría con separadores y agrega el pie de página configurado", () => {
    const base = {
      establishment: "La Brasa",
      tableNumber: "3",
      waiter: "Juan",
      createdAt: 0,
      totalCents: 30000,
      lines: [
        { quantity: 2, name: "Taco de calamar", totalCents: 17000, category: "Tacos" },
        { quantity: 1, name: "Arrachera", totalCents: 8000, category: "Platos fuertes" },
        { quantity: 1, name: "Taco pastor", totalCents: 5000, category: "Tacos" },
      ],
    };
    const plain = renderBill(base, 80).join("\n");
    expect(plain).not.toContain("TACOS");
    const grouped = renderBill(base, 80, {
      sep: "*",
      groupCategories: true,
      footer: "WiFi: brasa2026\nSíguenos @labrasa",
    }).join("\n");
    expect(grouped).toContain("TACOS");
    expect(grouped).toContain("PLATOS FUERTES");
    expect(grouped.indexOf("Taco pastor")).toBeLessThan(grouped.indexOf("PLATOS FUERTES")); // los tacos quedan juntos
    expect(grouped).toContain("WiFi: brasa2026");
    expect(grouped).toContain("Síguenos @labrasa");
  });

  it("los tiempos viajan con la comanda hasta la impresora, la cocina (KDS) y respetan el estilo guardado", async () => {
    const t = await admin();
    await call(t, "PUT", "/api/settings", {
      ticket_separator: "=",
      ticket_group_categories: true,
      ticket_footer: "Gracias",
    });
    const s = (await call(t, "GET", "/api/settings")).body;
    expect(s).toMatchObject({
      ticket_separator: "=",
      ticket_group_categories: true,
      ticket_footer: "Gracias",
    });
    expect((await call(t, "PUT", "/api/settings", { ticket_separator: "X" })).status).toBe(400);

    const products = (await call(t, "GET", "/api/products")).body as { id: string; name: string }[];
    const burger = products.find((p) => p.name === "Hamburguesa clásica")!.id;
    const marg = products.find((p) => p.name === "Margarita")!.id;
    const juan = await pin("Juan", "1111");
    const tbl = ((await call(t, "GET", "/api/tables")).body as { id: string }[])[0]!.id;
    const acc = (await call(juan, "POST", `/api/tables/${tbl}/open`, {})).body.id as string;
    await call(juan, "POST", `/api/accounts/${acc}/orders`, {
      items: [
        { productId: marg, course: "Para empezar" },
        { productId: burger, course: "Plato fuerte" },
      ],
    });
    await processQueue(db, transport, hub);
    const cocina = transport.sent.find((x) => x.host === "192.168.1.50")!;
    expect(cocina.text).toContain("PLATO FUERTE");
    expect(cocina.text).not.toContain("PARA EMPEZAR"); // ese tiempo es de barra, no de cocina

    const plancha = (
      (await db.prepare("SELECT id FROM stations WHERE name='Plancha'").get()) as { id: string }
    ).id;
    const q = (await call(t, "GET", `/api/stations/${plancha}/queue`)).body as {
      lines: { course: string | null }[];
    }[];
    expect(q[0]!.lines[0]!.course).toBe("Plato fuerte");

    // los productos salen en el orden en que se pidieron (el tiempo sin nombre primero, luego cada tiempo)
    const acc2 = (
      await call(
        juan,
        "POST",
        `/api/tables/${((await call(t, "GET", "/api/tables")).body as { id: string }[])[1]!.id}/open`,
        {},
      )
    ).body.id as string;
    const ens = products.find((p) => p.name === "Ensalada")!.id;
    await call(juan, "POST", `/api/accounts/${acc2}/orders`, {
      items: [
        { productId: ens },
        { productId: burger, course: "Plato fuerte" },
        { productId: ens, course: "Postre" },
      ],
    });
    const fr = (
      (await db.prepare("SELECT id FROM stations WHERE name='Fríos'").get()) as { id: string }
    ).id;
    const q2 = (await call(t, "GET", `/api/stations/${fr}/queue`)).body as {
      lines: { name: string; course: string | null }[];
    }[];
    expect(q2[0]!.lines.map((l) => l.course)).toEqual([null, "Postre"]);
    // el curso se guarda en la cuenta
    const item = (await db
      .prepare("SELECT course FROM order_items WHERE name='Margarita'")
      .get()) as { course: string };
    expect(item.course).toBe("Para empezar");
  });

  it("la vista previa usa el mismo renderizador y el estilo indicado", async () => {
    const t = await admin();
    const r = (
      await call(t, "POST", "/api/ticket-preview", {
        sep: "*",
        groupCategories: true,
        footer: "Vuelva pronto",
        paper: 58,
      })
    ).body as { comanda: string[]; bill: string[] };
    expect(r.comanda.join("\n")).toContain("ENTRADAS");
    expect(r.comanda.join("\n")).toContain("*".repeat(32));
    expect(r.bill.join("\n")).toContain("TACOS");
    expect(r.bill.join("\n")).toContain("Vuelva pronto");
    expect((await call(t, "POST", "/api/ticket-preview", { sep: "ñ" })).status).toBe(400);
  });
});
