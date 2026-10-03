import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { openDb, type Db } from "../src/db";
import { seed } from "../src/seed";

let app: FastifyInstance;
let db: Db;
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
  db = await openDb(":memory:");
  await seed(db, "admin1234");
  app = buildApp(db);
  adm = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin1234" } })).json().token as string;
});

const area = async (name: string) => (await c(adm, "POST", "/api/inventory/areas", { name })).body.id as string;
const cat = async (areaId: string, name: string) => (await c(adm, "POST", "/api/inventory/categories", { area_id: areaId, name })).body.id as string;
const item = async (o: Record<string, unknown>) => {
  const r = await c(adm, "POST", "/api/inventory/items", { unit: "kg", ...o });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
};
const stock = (itemId: string, qty: number) => c(adm, "POST", "/api/inventory/movements", { itemId, kind: "entrada", quantity: qty });
const stockOf = async (itemId: string) => (await db.prepare("SELECT stock FROM inventory_items WHERE id=?").get(itemId) as { stock: number }).stock;

describe("áreas y categorías de inventario", () => {
  it("la migración deja áreas de partida editables (Cocina, Barra, Limpieza y desechables)", async () => {
    const areas = (await c(adm, "GET", "/api/inventory/areas")).body as { name: string }[];
    expect(areas.map((a) => a.name)).toEqual(expect.arrayContaining(["Cocina", "Barra", "Limpieza y desechables"]));
  });

  it("el usuario crea áreas y categorías propias y asigna insumos", async () => {
    const cocina = (await c(adm, "GET", "/api/inventory/areas")).body.find((a: { name: string }) => a.name === "Cocina").id as string;
    const mariscos = await cat(cocina, "Mariscos");
    const enlatados = await cat(cocina, "Enlatados");
    const perecederos = await cat(cocina, "Perecederos");
    const camaron = await item({ name: "Camarón", area_id: cocina, category_id: mariscos });
    await item({ name: "Atún en lata", area_id: cocina, category_id: enlatados });
    await item({ name: "Jitomate", area_id: cocina, category_id: perecederos });
    const rows = (await c(adm, "GET", "/api/inventory/items")).body as { name: string; area_id: string; category_id: string }[];
    expect(rows.find((r) => r.name === "Camarón")).toMatchObject({ area_id: cocina, category_id: mariscos });
    // se puede mover a otra categoría de la misma área
    expect((await c(adm, "PATCH", `/api/inventory/items/${camaron}`, { category_id: perecederos })).status).toBe(200);
    expect((await db.prepare("SELECT category_id FROM inventory_items WHERE id=?").get(camaron) as { category_id: string }).category_id).toBe(perecederos);
  });

  it("no permite nombres repetidos de área ni de categoría dentro de la misma área (sin importar mayúsculas)", async () => {
    const barra = await area("Terraza bar");
    expect((await c(adm, "POST", "/api/inventory/areas", { name: "terraza BAR" })).status).toBe(400);
    await cat(barra, "Licores");
    expect((await c(adm, "POST", "/api/inventory/categories", { area_id: barra, name: "licores" })).status).toBe(400);
    const otra = await area("Almacén");
    expect((await c(adm, "POST", "/api/inventory/categories", { area_id: otra, name: "Licores" })).status).toBe(201); // en otra área sí
  });

  it("una categoría debe pertenecer al área del insumo y al cambiar de área se limpia la categoría", async () => {
    const a1 = await area("Área 1");
    const a2 = await area("Área 2");
    const c1 = await cat(a1, "Cat 1");
    expect((await c(adm, "POST", "/api/inventory/items", { name: "X", unit: "kg", area_id: a2, category_id: c1 })).status).toBe(400);
    expect((await c(adm, "POST", "/api/inventory/items", { name: "Y", unit: "kg", category_id: "no-existe", area_id: a1 })).status).toBe(400);
    const it = await item({ name: "Z", area_id: a1, category_id: c1 });
    expect((await c(adm, "PATCH", `/api/inventory/items/${it}`, { area_id: a2 })).status).toBe(200);
    expect((await db.prepare("SELECT area_id, category_id FROM inventory_items WHERE id=?").get(it) as { area_id: string; category_id: string | null })).toEqual({ area_id: a2, category_id: null });
  });

  it("no se borra un área ni una categoría con insumos; vacías sí", async () => {
    const a = await area("Temporal");
    const k = await cat(a, "Temporal cat");
    const it = await item({ name: "Con área", area_id: a, category_id: k });
    expect((await c(adm, "DELETE", `/api/inventory/categories/${k}`)).status).toBeGreaterThanOrEqual(400);
    expect((await c(adm, "DELETE", `/api/inventory/areas/${a}`)).status).toBeGreaterThanOrEqual(400);
    await c(adm, "PATCH", `/api/inventory/items/${it}`, { area_id: null, category_id: null });
    expect((await c(adm, "DELETE", `/api/inventory/categories/${k}`)).status).toBe(200);
    expect((await c(adm, "DELETE", `/api/inventory/areas/${a}`)).status).toBe(200);
  });

  it("el máximo nunca puede ser menor que el mínimo", async () => {
    expect((await c(adm, "POST", "/api/inventory/items", { name: "Sal", unit: "kg", min_stock: 10, max_stock: 5 })).status).toBe(400);
    const it = await item({ name: "Azúcar", min_stock: 5, max_stock: 20 });
    expect((await c(adm, "PATCH", `/api/inventory/items/${it}`, { max_stock: 3 })).status).toBe(400);
    expect((await c(adm, "PATCH", `/api/inventory/items/${it}`, { min_stock: 25 })).status).toBe(400);
    expect((await c(adm, "PATCH", `/api/inventory/items/${it}`, { max_stock: 30 })).status).toBe(200);
  });

  it("solo quien puede modificar inventario crea áreas; quien puede verlo las lee", async () => {
    const mesero = await pin("Juan", "1111");
    expect((await c(mesero, "POST", "/api/inventory/areas", { name: "Intrusa" })).status).toBe(403);
    const gerente = (await c(adm, "POST", "/api/users", { name: "Gerente prueba", role: "gerente", pin: "5151" })).body.id as string;
    void gerente;
    const g = await pin("Gerente prueba", "5151");
    expect((await c(g, "POST", "/api/inventory/areas", { name: "Del gerente" })).status).toBe(201);
    expect((await c(mesero, "GET", "/api/inventory/areas")).status).toBe(403); // el mesero ni siquiera ve inventario
  });
});

describe("límites y cuándo pedir", () => {
  it("avisa solo lo que llegó al mínimo y sugiere llegar al máximo", async () => {
    const a = await item({ name: "Camarón", unit: "kg", min_stock: 5, max_stock: 20 });
    const b = await item({ name: "Limón", unit: "pza", min_stock: 100 }); // sin máximo: se sugiere el doble del mínimo
    await item({ name: "Sal", unit: "kg", min_stock: 0 }); // sin límite: nunca avisa
    const c3 = await item({ name: "Arroz", unit: "kg", min_stock: 10, max_stock: 40 });
    await stock(a, 3);
    await stock(b, 40);
    await stock(c3, 25);
    const rows = (await c(adm, "GET", "/api/inventory/reorder")).body as { itemId: string; suggested: number; level: string }[];
    expect(rows.map((r) => r.itemId).sort()).toEqual([a, b].sort());
    expect(rows.find((r) => r.itemId === a)).toMatchObject({ suggested: 17, level: "bajo" });
    expect(rows.find((r) => r.itemId === b)).toMatchObject({ suggested: 160, level: "bajo" });
  });

  it("agotado y negativo también se piden; pasado el mínimo ya no", async () => {
    const x = await item({ name: "Hielo", unit: "kg", min_stock: 4, max_stock: 12 });
    let rows = (await c(adm, "GET", "/api/inventory/reorder")).body as { itemId: string; level: string; suggested: number }[];
    expect(rows.find((r) => r.itemId === x)).toMatchObject({ level: "agotado", suggested: 12 });
    await stock(x, 5);
    expect((await c(adm, "GET", "/api/inventory/reorder")).body).toEqual([]);
    await c(adm, "POST", "/api/inventory/movements", { itemId: x, kind: "salida", quantity: 9 }); // queda en -4
    rows = (await c(adm, "GET", "/api/inventory/reorder")).body;
    expect(rows.find((r) => r.itemId === x)?.suggested).toBeGreaterThan(0);
  });

  it("se puede acotar por área o por categoría", async () => {
    const cocina = await area("Cocina fría");
    const barra = await area("Barra fría");
    const k = await cat(cocina, "Verduras");
    await item({ name: "Lechuga", area_id: cocina, category_id: k, min_stock: 3 });
    await item({ name: "Ron", unit: "l", area_id: barra, min_stock: 2 });
    const all = (await c(adm, "GET", "/api/inventory/reorder")).body as unknown[];
    expect(all).toHaveLength(2);
    expect(((await c(adm, "GET", `/api/inventory/reorder?areaId=${barra}`)).body as { name: string }[]).map((r) => r.name)).toEqual(["Ron"]);
    expect(((await c(adm, "GET", `/api/inventory/reorder?categoryId=${k}`)).body as { name: string }[]).map((r) => r.name)).toEqual(["Lechuga"]);
  });

  it("los insumos de piezas se sugieren en enteros", async () => {
    const x = await item({ name: "Huevo", unit: "pza", min_stock: 30, max_stock: 120.5 });
    await stock(x, 10);
    const r = ((await c(adm, "GET", "/api/inventory/reorder")).body as { itemId: string; suggested: number }[]).find((r) => r.itemId === x)!;
    expect(Number.isInteger(r.suggested)).toBe(true);
    expect(r.suggested).toBe(111);
  });
});

describe("listas de compras", () => {
  it("la lista automática trae lo que hay que pedir, agrupado por área y categoría", async () => {
    const cocina = await area("Cocina caliente");
    const mar = await cat(cocina, "Mariscos");
    const camaron = await item({ name: "Camarón", area_id: cocina, category_id: mar, min_stock: 5, max_stock: 20 });
    await item({ name: "Pulpo", area_id: cocina, category_id: mar, min_stock: 2, max_stock: 6 });
    await item({ name: "Arroz", min_stock: 10 });
    await stock(camaron, 1);
    const r = await c(adm, "POST", "/api/shopping-lists", { auto: true, name: "Pedido del viernes" });
    expect(r.status).toBe(201);
    expect(r.body.items).toBe(3);
    const list = (await c(adm, "GET", `/api/shopping-lists/${r.body.id}`)).body;
    expect(list.name).toBe("Pedido del viernes");
    expect(list.kind).toBe("auto");
    expect(list.lines.map((l: { name: string }) => l.name).sort()).toEqual(["Arroz", "Camarón", "Pulpo"]);
    expect(list.lines.find((l: { name: string }) => l.name === "Camarón")).toMatchObject({ quantity: 19, area: "Cocina caliente", category: "Mariscos" });
  });

  it("se puede acotar la lista automática a un área", async () => {
    const a = await area("Solo esta");
    await item({ name: "Uno", area_id: a, min_stock: 1 });
    await item({ name: "Dos", min_stock: 1 });
    const r = await c(adm, "POST", "/api/shopping-lists", { auto: true, areaId: a });
    expect(r.body.items).toBe(1);
  });

  it("también se arman a mano: insumos del inventario o artículos libres, y se suman cantidades repetidas", async () => {
    const harina = await item({ name: "Harina", unit: "kg" });
    const { body } = await c(adm, "POST", "/api/shopping-lists", { name: "Mercado" });
    const id = body.id as string;
    await c(adm, "POST", `/api/shopping-lists/${id}/items`, { itemId: harina, quantity: 5 });
    await c(adm, "POST", `/api/shopping-lists/${id}/items`, { itemId: harina, quantity: 3 });
    await c(adm, "POST", `/api/shopping-lists/${id}/items`, { name: "Bolsas para llevar", unit: "paq", quantity: 2, note: "las chicas" });
    expect((await c(adm, "POST", `/api/shopping-lists/${id}/items`, { quantity: 1 })).status).toBe(400); // sin nombre ni insumo
    expect((await c(adm, "POST", `/api/shopping-lists/${id}/items`, { name: "Cero", quantity: 0 })).status).toBe(400);
    const lines = (await c(adm, "GET", `/api/shopping-lists/${id}`)).body.lines as { name: string; quantity: number; note: string | null }[];
    expect(lines.find((l) => l.name === "Harina")?.quantity).toBe(8);
    expect(lines.find((l) => l.name === "Bolsas para llevar")?.note).toBe("las chicas");
  });

  it("edita cantidades, marca lo comprado, quita renglones y renombra la lista", async () => {
    const x = await item({ name: "Cebolla", unit: "kg" });
    const id = (await c(adm, "POST", "/api/shopping-lists", { name: "Provisional" })).body.id as string;
    const lid = (await c(adm, "POST", `/api/shopping-lists/${id}/items`, { itemId: x, quantity: 4 })).body.id as string;
    expect((await c(adm, "PATCH", `/api/shopping-lists/${id}/items/${lid}`, { quantity: 6.5, checked: true })).status).toBe(200);
    expect((await c(adm, "PATCH", `/api/shopping-lists/${id}`, { name: "Mercado del sábado", notes: "Pagar en efectivo" })).status).toBe(200);
    let list = (await c(adm, "GET", `/api/shopping-lists/${id}`)).body;
    expect(list).toMatchObject({ name: "Mercado del sábado", notes: "Pagar en efectivo" });
    expect(list.lines[0]).toMatchObject({ quantity: 6.5, checked: 1 });
    expect((await c(adm, "DELETE", `/api/shopping-lists/${id}/items/${lid}`)).status).toBe(200);
    list = (await c(adm, "GET", `/api/shopping-lists/${id}`)).body;
    expect(list.lines).toEqual([]);
    expect((await c(adm, "DELETE", `/api/shopping-lists/${id}/items/${lid}`)).status).toBe(404);
  });

  it("«actualizar» agrega solo lo que se agotó después, sin duplicar ni borrar lo manual", async () => {
    const a = await item({ name: "Aceite", unit: "l", min_stock: 5, max_stock: 15 });
    const id = (await c(adm, "POST", "/api/shopping-lists", { auto: true })).body.id as string;
    await c(adm, "POST", `/api/shopping-lists/${id}/items`, { name: "Velas", quantity: 1 });
    const b = await item({ name: "Vinagre", unit: "l", min_stock: 2 });
    const r = await c(adm, "POST", `/api/shopping-lists/${id}/refresh`, {});
    expect(r.body.added).toBe(1); // solo Vinagre; Aceite ya estaba
    const again = await c(adm, "POST", `/api/shopping-lists/${id}/refresh`, {});
    expect(again.body.added).toBe(0);
    const names = ((await c(adm, "GET", `/api/shopping-lists/${id}`)).body.lines as { name: string }[]).map((l) => l.name).sort();
    expect(names).toEqual(["Aceite", "Velas", "Vinagre"]);
    void a; void b;
  });

  it("el texto para compartir lleva el negocio, los grupos, las cantidades y lo ya marcado", async () => {
    const cocina = await area("Cocina texto");
    const k = await cat(cocina, "Perecederos");
    const x = await item({ name: "Jitomate", unit: "kg", area_id: cocina, category_id: k, min_stock: 3, max_stock: 10 });
    const id = (await c(adm, "POST", "/api/shopping-lists", { auto: true, name: "Texto" })).body.id as string;
    const lid = (await c(adm, "GET", `/api/shopping-lists/${id}`)).body.lines[0].id as string;
    await c(adm, "PATCH", `/api/shopping-lists/${id}/items/${lid}`, { checked: true });
    const text = (await c(adm, "GET", `/api/shopping-lists/${id}/text`)).body as string;
    expect(text).toContain("LISTA DE COMPRAS");
    expect(text).toContain("— Cocina texto › Perecederos —");
    expect(text).toContain("[x] Jitomate: 10 kg");
    expect(text).toContain("1 artículo(s)");
    void x;
  });

  it("compartir genera un enlace público; quien lo abre ve la lista y marca lo comprado sin iniciar sesión", async () => {
    const x = await item({ name: "Tortilla", unit: "kg", min_stock: 5, max_stock: 20 });
    const id = (await c(adm, "POST", "/api/shopping-lists", { auto: true, name: "Para Doña Mary" })).body.id as string;
    const share = (await c(adm, "POST", `/api/shopping-lists/${id}/share`, {})).body;
    expect(share.token).toMatch(/^[a-f0-9]{24}$/);
    expect(share.path).toBe(`/s?t=${share.token}`);
    expect(share.whatsapp).toContain("https://wa.me/?text=");
    expect(share.text).toContain("Tortilla");
    // el mismo enlace se reutiliza
    expect((await c(adm, "POST", `/api/shopping-lists/${id}/share`, {})).body.token).toBe(share.token);
    expect((await db.prepare("SELECT status FROM shopping_lists WHERE id=?").get(id) as { status: string }).status).toBe("compartida");

    const pub = await c(null, "GET", `/api/shared/shopping/${share.token}`);
    expect(pub.status).toBe(200);
    expect(pub.body.name).toBe("Para Doña Mary");
    expect(pub.body.lines).toHaveLength(1);
    expect(JSON.stringify(pub.body)).not.toMatch(/stock|unit_cost|created_by/); // no se filtra información interna
    const lid = pub.body.lines[0].id as string;
    expect((await c(null, "PATCH", `/api/shared/shopping/${share.token}/items/${lid}`, { checked: true })).status).toBe(200);
    expect((await db.prepare("SELECT checked FROM shopping_list_items WHERE id=?").get(lid) as { checked: number }).checked).toBe(1);
    // un enlace inventado o mal formado no revela nada
    expect((await c(null, "GET", "/api/shared/shopping/000000000000000000000000")).status).toBe(404);
    expect((await c(null, "GET", "/api/shared/shopping/xyz")).status).toBeGreaterThanOrEqual(400);
    // dejar de compartir invalida el enlace
    expect((await c(adm, "POST", `/api/shopping-lists/${id}/unshare`, {})).status).toBe(200);
    expect((await c(null, "GET", `/api/shared/shopping/${share.token}`)).status).toBe(404);
    void x;
  });

  it("el enlace público no permite marcar renglones de otra lista", async () => {
    const x = await item({ name: "Tomate", unit: "kg", min_stock: 1 });
    const y = await item({ name: "Cilantro", unit: "kg", min_stock: 1 });
    const l1 = (await c(adm, "POST", "/api/shopping-lists", { auto: true })).body.id as string;
    const l2 = (await c(adm, "POST", "/api/shopping-lists", { name: "Otra" })).body.id as string;
    await c(adm, "POST", `/api/shopping-lists/${l2}/items`, { itemId: y, quantity: 1 });
    const t1 = (await c(adm, "POST", `/api/shopping-lists/${l1}/share`, {})).body.token as string;
    const foreign = (await c(adm, "GET", `/api/shopping-lists/${l2}`)).body.lines[0].id as string;
    expect((await c(null, "PATCH", `/api/shared/shopping/${t1}/items/${foreign}`, { checked: true })).status).toBe(404);
    void x;
  });

  it("recibir lo comprado suma al inventario solo lo marcado y cierra la lista", async () => {
    const a = await item({ name: "Camarón", unit: "kg", min_stock: 5, max_stock: 20 });
    const b = await item({ name: "Pulpo", unit: "kg", min_stock: 3, max_stock: 10 });
    const id = (await c(adm, "POST", "/api/shopping-lists", { auto: true })).body.id as string;
    const lines = (await c(adm, "GET", `/api/shopping-lists/${id}`)).body.lines as { id: string; name: string; quantity: number }[];
    expect((await c(adm, "POST", `/api/shopping-lists/${id}/receive`, {})).status).toBe(409); // nada marcado
    const cam = lines.find((l) => l.name === "Camarón")!;
    await c(adm, "PATCH", `/api/shopping-lists/${id}/items/${cam.id}`, { checked: true, quantity: 18 });
    const r = await c(adm, "POST", `/api/shopping-lists/${id}/receive`, {});
    expect(r.body).toEqual({ received: 1, skipped: 0 });
    expect(await stockOf(a)).toBe(18);
    expect(await stockOf(b)).toBe(0);
    expect((await db.prepare("SELECT status FROM shopping_lists WHERE id=?").get(id) as { status: string }).status).toBe("comprada");
    // la lista cerrada ya no se edita y no se recibe dos veces
    expect((await c(adm, "POST", `/api/shopping-lists/${id}/receive`, {})).status).toBe(409);
    expect((await c(adm, "POST", `/api/shopping-lists/${id}/items`, { name: "Tarde", quantity: 1 })).status).toBe(409);
    const mov = await db.prepare("SELECT kind, quantity FROM inventory_movements WHERE item_id=? ORDER BY rowid DESC LIMIT 1").get(a) as { kind: string; quantity: number };
    expect(mov).toEqual({ kind: "compra", quantity: 18 });
  });

  it("la lista se convierte en órdenes de compra por proveedor habitual", async () => {
    const s1 = (await c(adm, "POST", "/api/suppliers", { name: "Pescadería" })).body.id as string;
    const s2 = (await c(adm, "POST", "/api/suppliers", { name: "Abarrotes" })).body.id as string;
    await item({ name: "Camarón", supplier_id: s1, min_stock: 5, max_stock: 20, unit_cost_cents: 18000 });
    await item({ name: "Pulpo", supplier_id: s1, min_stock: 2, max_stock: 6 });
    await item({ name: "Arroz", supplier_id: s2, min_stock: 4 });
    await item({ name: "Sin proveedor", min_stock: 1 });
    const id = (await c(adm, "POST", "/api/shopping-lists", { auto: true })).body.id as string;
    const r = await c(adm, "POST", `/api/shopping-lists/${id}/purchase-orders`, {});
    expect(r.status).toBe(201);
    expect(r.body.orders).toHaveLength(2);
    expect(r.body.unassigned).toEqual(["Sin proveedor"]);
    const pos = await db.prepare("SELECT supplier_id, status FROM purchase_orders").all() as { supplier_id: string; status: string }[];
    expect(pos.map((p) => p.supplier_id).sort()).toEqual([s1, s2].sort());
    expect(pos.every((p) => p.status === "borrador")).toBe(true);
  });

  it("los permisos se respetan: el mesero no ve listas; el supervisor las ve pero no las edita", async () => {
    const mesero = await pin("Juan", "1111");
    expect((await c(mesero, "GET", "/api/shopping-lists")).status).toBe(403);
    await c(adm, "POST", "/api/users", { name: "Super", role: "supervisor", pin: "6161" });
    const sup = await pin("Super", "6161");
    expect((await c(sup, "GET", "/api/shopping-lists")).status).toBe(200);
    expect((await c(sup, "POST", "/api/shopping-lists", { name: "No" })).status).toBe(403);
    expect((await c(sup, "POST", `/api/shopping-lists/x/share`, {})).status).toBe(403);
  });

  it("borrar la lista borra sus renglones y los datos inventados no rompen nada", async () => {
    const id = (await c(adm, "POST", "/api/shopping-lists", { name: "'; DROP TABLE users; --" })).body.id as string;
    await c(adm, "POST", `/api/shopping-lists/${id}/items`, { name: "<script>alert(1)</script>", quantity: 2 });
    expect((await c(adm, "DELETE", `/api/shopping-lists/${id}`)).status).toBe(200);
    expect((await db.prepare("SELECT COUNT(*) c FROM shopping_list_items").get() as { c: number }).c).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) c FROM users").get() as { c: number }).c).toBeGreaterThan(3);
    expect((await c(adm, "GET", "/api/shopping-lists/no-existe")).status).toBe(404);
  });
});
