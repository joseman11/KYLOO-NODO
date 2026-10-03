import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { openDb } from "../src/db";
import { seed } from "../src/seed";

let app: FastifyInstance;

beforeEach(async () => {
  const db = await openDb(":memory:");
  await seed(db, "admin1234");
  app = buildApp(db);
});

async function loginAdmin() {
  const r = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "admin", password: "admin1234" },
  });
  return { Authorization: `Bearer ${r.json().token}` };
}

async function loginPin(name: string, pin: string) {
  const users = (await app.inject({ method: "GET", url: "/api/auth/users" })).json() as {
    id: string;
    name: string;
  }[];
  const u = users.find((x) => x.name === name)!;
  return app.inject({ method: "POST", url: "/api/auth/pin", payload: { userId: u.id, pin } });
}

describe("auth", () => {
  it("login por PIN de mesero y rechazo de PIN incorrecto", async () => {
    expect((await loginPin("Juan", "1111")).statusCode).toBe(200);
    expect((await loginPin("Juan", "9999")).statusCode).toBe(401);
  });

  it("bloquea tras 5 intentos fallidos", async () => {
    for (let i = 0; i < 5; i++) await loginPin("Pedro", "0000");
    expect((await loginPin("Pedro", "2222")).statusCode).toBe(429);
  });

  it("exige sesión", async () => {
    expect((await app.inject({ method: "GET", url: "/api/products" })).statusCode).toBe(401);
  });

  it("un mesero no puede crear productos (RN-015)", async () => {
    const { token } = (await loginPin("Juan", "1111")).json();
    const r = await app.inject({
      method: "POST",
      url: "/api/products",
      headers: { Authorization: `Bearer ${token}` },
      payload: { name: "X", price_cents: 100, station_ids: ["s"] },
    });
    expect(r.statusCode).toBe(403);
  });
});

describe("catálogo", () => {
  it("el seed deja 3 productos, cada uno con ruta de producción", async () => {
    const h = await loginAdmin();
    const products = (await app.inject({ method: "GET", url: "/api/products", headers: h })).json();
    expect(products).toHaveLength(3);
    for (const p of products) expect(p.station_ids.length).toBeGreaterThan(0);
  });

  it("rechaza un producto sin ruta (RN-003)", async () => {
    const h = await loginAdmin();
    const r = await app.inject({
      method: "POST",
      url: "/api/products",
      headers: h,
      payload: { name: "Sin ruta", price_cents: 500, station_ids: [] },
    });
    expect(r.statusCode).toBe(400);
  });

  it("crea producto con ruta y modificadores, y queda en auditoría", async () => {
    const h = await loginAdmin();
    const stations = (await app.inject({ method: "GET", url: "/api/stations", headers: h })).json();
    const g = await app.inject({
      method: "POST",
      url: "/api/modifier-groups",
      headers: h,
      payload: {
        name: "Término",
        required: true,
        modifiers: [{ name: "Medio" }, { name: "Bien cocida" }],
      },
    });
    expect(g.statusCode).toBe(201);
    const p = await app.inject({
      method: "POST",
      url: "/api/products",
      headers: h,
      payload: {
        name: "Pizza",
        price_cents: 12000,
        station_ids: [stations[0].id],
        modifier_group_ids: [g.json().id],
      },
    });
    expect(p.statusCode).toBe(201);
    const audit = (await app.inject({ method: "GET", url: "/api/audit", headers: h })).json();
    expect(
      audit.some(
        (a: { action: string; entity: string }) => a.action === "crear" && a.entity === "product",
      ),
    ).toBe(true);
  });

  it("cocina puede marcar un producto agotado (HU-026)", async () => {
    const admin = await loginAdmin();
    await app.inject({
      method: "POST",
      url: "/api/users",
      headers: admin,
      payload: { name: "Chef", role: "cocina", pin: "4444" },
    });
    const { token } = (await loginPin("Chef", "4444")).json();
    const [p] = (await app.inject({ method: "GET", url: "/api/products", headers: admin })).json();
    const r = await app.inject({
      method: "POST",
      url: `/api/products/${p.id}/availability`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { availability: "agotado" },
    });
    expect(r.statusCode).toBe(200);
  });
});

describe("estructura", () => {
  it("la bitácora es append-only", async () => {
    const db = await openDb(":memory:");
    await db.prepare("INSERT INTO audit_log (ts, action) VALUES (1,'x')").run();
    await expect(db.prepare("DELETE FROM audit_log").run()).rejects.toThrow(/append-only/);
  });

  it("lista mesas ordenadas numéricamente", async () => {
    const h = await loginAdmin();
    const t = (await app.inject({ method: "GET", url: "/api/tables", headers: h })).json();
    expect(t.map((x: { number: string }) => x.number)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
    ]);
  });
});
