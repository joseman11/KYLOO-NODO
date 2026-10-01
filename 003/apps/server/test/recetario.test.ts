import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { openDb, type Db } from "../src/db";
import { seed } from "../src/seed";
import { placeholderPng } from "../src/demo-png";

let app: FastifyInstance;
let db: Db;
let photosDir: string;
type M = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const c = async (t: string | null, method: M, url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers: t ? { Authorization: `Bearer ${t}` } : undefined, payload: payload as object });
  const ct = r.headers["content-type"]?.toString() ?? "";
  return { status: r.statusCode, body: r.body ? (ct.includes("json") ? r.json() : r.body) : null };
};
async function pin(name: string, p: string) {
  const users = (await app.inject({ method: "GET", url: "/api/auth/users" })).json() as { id: string; name: string }[];
  const u = users.find((x) => x.name === name)!;
  return (await app.inject({ method: "POST", url: "/api/auth/pin", payload: { userId: u.id, pin: p } })).json().token as string;
}
let adm = "";
beforeEach(async () => {
  db = openDb(":memory:");
  seed(db, "admin1234");
  photosDir = mkdtempSync(join(tmpdir(), "recetario-"));
  app = buildApp(db, { photosDir });
  adm = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin1234" } })).json().token as string;
});

const cat = async (name: string) => (await c(adm, "POST", "/api/recipe-categories", { name })).body.id as string;
const insumo = async (o: Record<string, unknown>) => (await c(adm, "POST", "/api/inventory/items", { unit: "g", ...o })).body.id as string;
const recipe = async (o: Record<string, unknown>) => {
  const r = await c(adm, "POST", "/api/recipe-book", o);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
};

describe("categorías del recetario", () => {
  it("vienen con un punto de partida editable y el usuario agrega las suyas (de comida a tragos)", async () => {
    const base = (await c(adm, "GET", "/api/recipe-categories")).body as { name: string }[];
    expect(base.map((x) => x.name)).toEqual(expect.arrayContaining(["Comida", "Bebidas y tragos", "Salsas y preparaciones", "Postres"]));
    await cat("Cocteles de la casa");
    await cat("Mariscos al carbón");
    const now = (await c(adm, "GET", "/api/recipe-categories")).body as { name: string }[];
    expect(now.map((x) => x.name)).toEqual(expect.arrayContaining(["Cocteles de la casa", "Mariscos al carbón"]));
  });

  it("no hay categorías repetidas y se pueden renombrar y borrar", async () => {
    const id = await cat("Brunch");
    expect((await c(adm, "POST", "/api/recipe-categories", { name: "brunch" })).status).toBe(400);
    expect((await c(adm, "PATCH", `/api/recipe-categories/${id}`, { name: "Desayunos" })).status).toBe(200);
    expect((await c(adm, "PATCH", `/api/recipe-categories/${id}`, { name: "Comida" })).status).toBe(400);
    expect((await c(adm, "DELETE", `/api/recipe-categories/${id}`)).status).toBe(200);
  });

  it("borrar una categoría no borra sus recetas: quedan sin categoría", async () => {
    const k = await cat("Temporal");
    const r = await recipe({ name: "Receta huérfana", category_id: k });
    expect((await c(adm, "DELETE", `/api/recipe-categories/${k}`)).status).toBe(200);
    const got = (await c(adm, "GET", `/api/recipe-book/${r}`)).body;
    expect(got.category_id).toBeNull();
    const sin = (await c(adm, "GET", "/api/recipe-book?uncategorized=true")).body as { name: string }[];
    expect(sin.map((x) => x.name)).toContain("Receta huérfana");
  });
});

describe("recetas", () => {
  it("guarda una receta con ingredientes del inventario, libres y su preparación", async () => {
    const camaron = await insumo({ name: "Camarón", unit: "g", unit_cost_cents: 28 });
    const limon = await insumo({ name: "Limón", unit: "pza", unit_cost_cents: 120 });
    const comida = (await c(adm, "GET", "/api/recipe-categories")).body.find((x: { name: string }) => x.name === "Comida").id as string;
    const id = await recipe({
      name: "Aguachile verde", category_id: comida, description: "Fresco y picoso", yield: 2, yield_unit: "porciones", prep_minutes: 15,
      instructions: "1. Limpiar el camarón.\n2. Licuar chile y limón.\n3. Bañar y servir.",
      ingredients: [{ itemId: camaron, quantity: 280 }, { itemId: limon, quantity: 8 }, { name: "Chile serrano", quantity: 3, unit: "pza", note: "al gusto" }],
    });
    const r = (await c(adm, "GET", `/api/recipe-book/${id}`)).body;
    expect(r).toMatchObject({ name: "Aguachile verde", category: "Comida", yield: 2, prep_minutes: 15 });
    expect(r.ingredients.map((i: { name: string }) => i.name)).toEqual(["Camarón", "Limón", "Chile serrano"]);
    expect(r.ingredients[2]).toMatchObject({ item_id: null, note: "al gusto", unit: "pza" });
    expect(r.instructions).toContain("3. Bañar");
    // costo del lote y por porción solo con lo ligado al inventario: 280×28 + 8×120 = 8800 → 4400 por porción
    expect(r.batch_cost_cents).toBe(8800);
    expect(r.cost_per_portion_cents).toBe(4400);
  });

  it("recetas de tragos junto a las de comida, con filtro por categoría y búsqueda", async () => {
    const tragos = await cat("Tragos");
    const salsas = await cat("Salsas");
    await recipe({ name: "Margarita", category_id: tragos, yield: 1, yield_unit: "copa" });
    await recipe({ name: "Mojito", category_id: tragos });
    await recipe({ name: "Salsa macha", category_id: salsas, yield: 20, yield_unit: "cucharadas" });
    await recipe({ name: "Ceviche" });
    expect(((await c(adm, "GET", `/api/recipe-book?categoryId=${tragos}`)).body as { name: string }[]).map((r) => r.name).sort()).toEqual(["Margarita", "Mojito"]);
    expect(((await c(adm, "GET", "/api/recipe-book?q=SALSA")).body as { name: string }[]).map((r) => r.name)).toEqual(["Salsa macha"]);
    expect(((await c(adm, "GET", "/api/recipe-book")).body as unknown[]).length).toBe(4);
    expect(((await c(adm, "GET", "/api/recipe-book?uncategorized=true")).body as { name: string }[]).map((r) => r.name)).toEqual(["Ceviche"]);
  });

  it("no permite recetas repetidas, rendimientos inválidos ni referencias inexistentes", async () => {
    await recipe({ name: "Flan" });
    expect((await c(adm, "POST", "/api/recipe-book", { name: "flan" })).status).toBe(409);
    expect((await c(adm, "POST", "/api/recipe-book", { name: "X", yield: 0 })).status).toBe(400);
    expect((await c(adm, "POST", "/api/recipe-book", { name: "X", yield: -3 })).status).toBe(400);
    expect((await c(adm, "POST", "/api/recipe-book", { name: "" })).status).toBe(400);
    expect((await c(adm, "POST", "/api/recipe-book", { name: "Y", category_id: "no-existe" })).status).toBe(400);
    expect((await c(adm, "POST", "/api/recipe-book", { name: "Z", ingredients: [{ itemId: "no-existe", quantity: 1 }] })).status).toBe(400);
    expect((await c(adm, "POST", "/api/recipe-book", { name: "W", ingredients: [{ quantity: 1 }] })).status).toBe(400); // sin nombre ni insumo
    expect((await c(adm, "POST", "/api/recipe-book", { name: "V", ingredients: [{ name: "Sal", quantity: 0 }] })).status).toBe(400);
  });

  it("edita datos y reemplaza ingredientes; borrar es lógico y libera el nombre", async () => {
    const a = await insumo({ name: "Harina" });
    const id = await recipe({ name: "Pan", ingredients: [{ itemId: a, quantity: 500 }] });
    expect((await c(adm, "PATCH", `/api/recipe-book/${id}`, { name: "Pan de la casa", yield: 8, ingredients: [{ name: "Agua", quantity: 300, unit: "ml" }] })).status).toBe(200);
    const r = (await c(adm, "GET", `/api/recipe-book/${id}`)).body;
    expect(r).toMatchObject({ name: "Pan de la casa", yield: 8 });
    expect(r.ingredients).toHaveLength(1);
    expect(r.ingredients[0].name).toBe("Agua");
    expect((await c(adm, "DELETE", `/api/recipe-book/${id}`)).status).toBe(200);
    expect((await c(adm, "GET", `/api/recipe-book/${id}`)).status).toBe(200); // sigue en la base (borrado lógico)
    expect(((await c(adm, "GET", "/api/recipe-book")).body as unknown[]).length).toBe(0);
    expect((await c(adm, "DELETE", `/api/recipe-book/${id}`)).status).toBe(404);
    await recipe({ name: "Pan de la casa" }); // el nombre quedó libre
  });

  it("el texto para compartir se escala a las porciones que se piden", async () => {
    const id = await recipe({ name: "Salsa macha", yield: 10, yield_unit: "porciones", instructions: "Tostar y moler.", ingredients: [{ name: "Chile de árbol", quantity: 100, unit: "g" }, { name: "Aceite", quantity: 250, unit: "ml", note: "caliente" }] });
    const base = (await c(adm, "GET", `/api/recipe-book/${id}/text`)).body as string;
    expect(base).toContain("SALSA MACHA");
    expect(base).toContain("- 100 g Chile de árbol");
    const x3 = (await c(adm, "GET", `/api/recipe-book/${id}/text?portions=30`)).body as string;
    expect(x3).toContain("30 porciones");
    expect(x3).toContain("- 300 g Chile de árbol");
    expect(x3).toContain("- 750 ml Aceite (caliente)");
    expect(x3).toContain("PREPARACIÓN");
    expect((await c(adm, "GET", `/api/recipe-book/${id}/text?portions=-2`)).status).toBe(400);
  });

  it("se puede ligar a un producto del menú para que cada venta descuente inventario", async () => {
    const camaron = await insumo({ name: "Camarón g", unit: "g", unit_cost_cents: 30 });
    const limon = await insumo({ name: "Limón pza", unit: "pza" });
    const stations = (await c(adm, "GET", "/api/stations")).body as { id: string }[];
    const prod = (await c(adm, "POST", "/api/products", { name: "Aguachile de prueba", price_cents: 18500, station_ids: [stations[0]!.id] })).body.id as string;
    const id = await recipe({ name: "Aguachile base", yield: 2, ingredients: [{ itemId: camaron, quantity: 300 }, { itemId: limon, quantity: 6 }, { name: "Cilantro", quantity: 1 }] });
    expect((await c(adm, "POST", `/api/recipe-book/${id}/apply-to-product`, {})).status).toBe(400); // sin producto
    const ok = await c(adm, "POST", `/api/recipe-book/${id}/apply-to-product`, { productId: prod });
    expect(ok.body).toEqual({ ok: true, items: 2 });
    const lines = (await c(adm, "GET", `/api/recipes/${prod}`)).body as { item_id: string; quantity: number }[];
    expect(lines.find((l) => l.item_id === camaron)?.quantity).toBe(150); // 300 g / 2 porciones
    expect(lines.find((l) => l.item_id === limon)?.quantity).toBe(3);
    expect(lines).toHaveLength(2); // el cilantro libre no está en el inventario
    expect(((await c(adm, "GET", `/api/recipe-book/${id}`)).body).product).toBe("Aguachile de prueba");
    // una receta sin insumos del inventario no puede aplicarse
    const libre = await recipe({ name: "Solo texto", ingredients: [{ name: "Sal", quantity: 1 }], product_id: prod });
    expect((await c(adm, "POST", `/api/recipe-book/${libre}/apply-to-product`, {})).status).toBe(409);
  });
});

describe("fotos y permisos del recetario", () => {
  it("sube, reemplaza y quita la foto de una receta", async () => {
    const id = await recipe({ name: "Con foto" });
    const png = (h: number) => "data:image/png;base64," + placeholderPng(h, 64, 48).toString("base64");
    const up = await c(adm, "POST", `/api/recipe-book/${id}/photo`, { data: png(10) });
    expect(up.status).toBe(200);
    expect(existsSync(join(photosDir, up.body.photo))).toBe(true);
    const again = await c(adm, "POST", `/api/recipe-book/${id}/photo`, { data: png(200) });
    expect(existsSync(join(photosDir, up.body.photo))).toBe(false);
    expect(existsSync(join(photosDir, again.body.photo))).toBe(true);
    expect((await c(adm, "GET", `/api/recipe-book/${id}`)).body.photo).toBe(again.body.photo);
    expect((await c(adm, "POST", `/api/recipe-book/${id}/photo`, { data: "data:image/png;base64," + Buffer.from("no soy png".repeat(30)).toString("base64") })).status).toBe(400);
    expect((await c(adm, "DELETE", `/api/recipe-book/${id}/photo`)).status).toBe(200);
    expect(existsSync(join(photosDir, again.body.photo))).toBe(false);
    rmSync(photosDir, { recursive: true, force: true });
  });

  it("todos leen el recetario; escriben quienes tienen permiso (admin, gerente, cocina, barra)", async () => {
    const id = await recipe({ name: "Leída por todos" });
    const mesero = await pin("Juan", "1111");
    expect((await c(mesero, "GET", "/api/recipe-book")).status).toBe(200);
    expect((await c(mesero, "GET", `/api/recipe-book/${id}`)).status).toBe(200);
    expect((await c(mesero, "POST", "/api/recipe-book", { name: "No" })).status).toBe(403);
    expect((await c(mesero, "PATCH", `/api/recipe-book/${id}`, { name: "No" })).status).toBe(403);
    expect((await c(mesero, "DELETE", `/api/recipe-book/${id}`)).status).toBe(403);
    expect((await c(mesero, "POST", "/api/recipe-categories", { name: "No" })).status).toBe(403);
    for (const [role, name, p] of [["cocina", "Chef", "4040"], ["bar", "Bartender", "4141"], ["gerente", "Gerente R", "4242"]] as const) {
      await c(adm, "POST", "/api/users", { name, role, pin: p });
      const t = await pin(name, p);
      expect((await c(t, "POST", "/api/recipe-book", { name: `Receta de ${role}` })).status, role).toBe(201);
    }
    await c(adm, "POST", "/api/users", { name: "Caja R", role: "cajero", pin: "4343" });
    expect((await c(await pin("Caja R", "4343"), "POST", "/api/recipe-book", { name: "No cajero" })).status).toBe(403);
    expect((await c(null, "GET", "/api/recipe-book")).status).toBe(401);
  });

  it("texto malicioso en nombre, pasos y notas se guarda como texto", async () => {
    const id = await recipe({ name: "<img src=x onerror=alert(1)>", instructions: "'); DROP TABLE recipe_book; --", ingredients: [{ name: "<b>sal</b>", quantity: 1, note: "' OR 1=1 --" }] });
    const r = (await c(adm, "GET", `/api/recipe-book/${id}`)).body;
    expect(r.name).toContain("<img");
    expect((db.prepare("SELECT COUNT(*) c FROM recipe_book").get() as { c: number }).c).toBe(1);
  });
});
