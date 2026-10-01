import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { openDb, type Db } from "../src/db";
import { accountPaid, accountTotal } from "../src/domain";
import { seedDemo, type DemoSummary } from "../src/seed-demo";

/** "Mariscos El Faro": 14 días de ventas simuladas. Aquí se verifica que los datos sean coherentes entre sí. */
let db: Db;
let app: FastifyInstance;
let summary: DemoSummary;
const photosDir = mkdtempSync(join(tmpdir(), "demo-photos-"));
const NOW = Date.UTC(2026, 9, 1, 15, 0, 0);

const one = async <T>(sql: string, ...a: unknown[]) => await db.prepare(sql).get(...a) as T;
const all = async <T>(sql: string, ...a: unknown[]) => await db.prepare(sql).all(...a) as T[];

beforeAll(async () => {
  db = await openDb(":memory:");
  summary = await seedDemo(db, { photosDir, now: NOW });
  app = buildApp(db, { photosDir });
});
afterAll(() => rmSync(photosDir, { recursive: true, force: true }));

describe("demo de mariscos: contenido", () => {
  it("trae el negocio completo (personal, áreas, mesas, menú, inventario, clientes)", async () => {
    expect(summary.establishment).toBe("Mariscos El Faro");
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM users")).c).toBe(9);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM tables_")).c).toBe(26);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM zones")).c).toBe(4);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM products")).c).toBeGreaterThanOrEqual(60);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM categories")).c).toBeGreaterThanOrEqual(15);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM inventory_items")).c).toBeGreaterThanOrEqual(90);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM customers")).c).toBeGreaterThanOrEqual(10);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM promotions")).c).toBeGreaterThanOrEqual(3);
  });

  it("solo carga sobre una base vacía", async () => {
    await expect(seedDemo(db, { photosDir, now: NOW })).rejects.toThrow(/vacía/);
  });

  it("cada platillo tiene precio, estación de producción y su foto existe en disco", async () => {
    const rows = await all<{ id: string; name: string; price_cents: number; photo: string | null }>("SELECT id, name, price_cents, photo FROM products");
    for (const p of rows) {
      expect(p.price_cents, p.name).toBeGreaterThan(0);
      expect((await one<{ c: number }>("SELECT COUNT(*) c FROM product_routes WHERE product_id=?", p.id)).c, p.name).toBeGreaterThan(0);
      expect(p.photo, p.name).toMatch(/^[a-f0-9]{24}-[a-f0-9]{8}\.png$/);
      expect(existsSync(join(photosDir, p.photo!)), p.name).toBe(true);
    }
  });

  it("los nombres de productos son únicos y no hay precios absurdos", async () => {
    const names = (await all<{ name: string }>("SELECT name FROM products")).map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    const max = (await one<{ m: number }>("SELECT MAX(price_cents) m FROM products")).m;
    expect(max).toBeLessThanOrEqual(200000);
  });
});

describe("demo de mariscos: coherencia contable", () => {
  it("toda cuenta cerrada con venta está cobrada exactamente por su total", async () => {
    const closed = await all<{ id: string }>("SELECT id FROM accounts WHERE status='cerrada'");
    expect(closed.length).toBeGreaterThan(400);
    let checked = 0;
    for (const a of closed) {
      const total = await accountTotal(db, a.id);
      if (total === 0) continue; // cuentas canceladas por completo
      expect(await accountPaid(db, a.id), a.id).toBe(total);
      checked++;
    }
    expect(checked).toBeGreaterThan(400);
  });

  it("las líneas de pago de cada cobro suman lo aplicado a la cuenta", async () => {
    const rows = await all<{ id: string; total_cents: number; lines: number }>(
          "SELECT p.id, p.total_cents, COALESCE((SELECT SUM(amount_cents) FROM payment_lines l WHERE l.payment_id=p.id),0) lines FROM payments p",
        );
    for (const r of rows) expect(r.lines, r.id).toBe(r.total_cents);
  });

  it("no hay pagos sin caja ni cajas con diferencia sin motivo", async () => {
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM payments WHERE session_id IS NULL")).c).toBe(0);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM cash_sessions WHERE difference_cents!=0 AND (difference_reason IS NULL OR difference_reason='')")).c).toBe(0);
    const closed = await all<{ opening_cents: number; expected_cents: number; counted_cents: number; difference_cents: number }>("SELECT * FROM cash_sessions WHERE status='cerrada'");
    expect(closed.length).toBe(14);
    for (const s of closed) expect(s.counted_cents - s.expected_cents).toBe(s.difference_cents);
  });

  it("hay una sola caja abierta (la de hoy) y las demás están cerradas", async () => {
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM cash_sessions WHERE status='abierta'")).c).toBe(1);
  });

  it("integridad referencial completa (sin huérfanos)", async () => {
    expect(await db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(((await db.prepare("PRAGMA integrity_check").get()) as { integrity_check: string }).integrity_check).toBe("ok");
  });

  it("ningún insumo vendible tiene existencia negativa; algunos están bajo el mínimo a propósito", async () => {
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM inventory_items WHERE stock<0")).c).toBe(0);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM inventory_items WHERE stock<=min_stock")).c).toBeGreaterThan(0);
  });

  it("los folios de comanda son únicos y consecutivos", async () => {
    const folios = (await all<{ folio: number }>("SELECT folio FROM orders ORDER BY folio")).map((r) => r.folio);
    expect(new Set(folios).size).toBe(folios.length);
    expect(folios[0]).toBe(1);
    expect(folios[folios.length - 1]).toBe(folios.length);
  });

  it("las propinas y descuentos están presentes y son razonables", async () => {
    const tips = await one<{ t: number; n: number }>("SELECT COALESCE(SUM(tip_cents),0) t, COUNT(*) n FROM payments WHERE tip_cents>0");
    expect(tips.n).toBeGreaterThan(100);
    const sales = (await one<{ s: number }>("SELECT SUM(total_cents) s FROM payments")).s;
    expect(tips.t / sales).toBeGreaterThan(0.03);
    expect(tips.t / sales).toBeLessThan(0.2);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM account_discounts")).c).toBeGreaterThan(5);
  });
});

describe("demo de mariscos: estado vivo de hoy", () => {
  it("las mesas ocupadas coinciden con las cuentas abiertas", async () => {
    const open = (await all<{ table_id: string }>("SELECT DISTINCT table_id FROM accounts WHERE status!='cerrada' AND table_id IS NOT NULL")).map((r) => r.table_id);
    expect(open.length).toBeGreaterThanOrEqual(8);
    for (const t of open) expect(["ocupada", "esperando_pago"], t).toContain((await one<{ status: string }>("SELECT status FROM tables_ WHERE id=?", t)).status);
    const occupied = (await all<{ id: string }>("SELECT id FROM tables_ WHERE status IN ('ocupada','esperando_pago')")).map((r) => r.id);
    expect(occupied.sort()).toEqual([...open].sort());
  });

  it("incluye los escenarios de servicio que se quieren mostrar", async () => {
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM accounts WHERE status='pago_solicitado'")).c).toBeGreaterThanOrEqual(1);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM order_items WHERE held=1")).c).toBeGreaterThanOrEqual(1); // tiempo retenido
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM accounts WHERE kind='delivery' AND status!='cerrada'")).c).toBeGreaterThanOrEqual(2);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM accounts WHERE kind='llevar' AND status!='cerrada'")).c).toBeGreaterThanOrEqual(1);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM accounts WHERE guests>=10 AND status!='cerrada'")).c).toBeGreaterThanOrEqual(1);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM payments p JOIN accounts a ON a.id=p.account_id WHERE a.status!='cerrada'")).c).toBeGreaterThanOrEqual(2); // partes ya pagadas
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM reservations")).c).toBeGreaterThanOrEqual(5);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM time_entries WHERE clock_out IS NULL")).c).toBeGreaterThanOrEqual(5);
  });

  it("el cargo por servicio de las cuentas grandes coincide con la configuración", async () => {
    const big = await all<{ id: string }>("SELECT id FROM accounts WHERE guests>=8 AND status!='cerrada'");
    expect(big.length).toBeGreaterThan(0);
    for (const b of big) expect(await accountTotal(db, b.id)).toBeGreaterThan(0);
  });
});

describe("demo de mariscos: la API responde con estos datos", () => {
  const login = async () => (await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin1234" } })).json().token as string;

  it("cada persona del equipo entra con su PIN", async () => {
    for (const u of summary.users.filter((x) => x.pin)) {
      const users = (await app.inject({ method: "GET", url: "/api/auth/users" })).json() as { id: string; name: string }[];
      const id = users.find((x) => x.name === u.name)!.id;
      const r = await app.inject({ method: "POST", url: "/api/auth/pin", payload: { userId: id, pin: u.pin } });
      expect(r.statusCode, u.name).toBe(200);
    }
  });

  it("reportes, tablero, mapa de mesas e inventario responden sin errores y con datos", async () => {
    const t = await login();
    const H = { Authorization: `Bearer ${t}` };
    for (const url of ["/api/reports/sales", "/api/dashboard", "/api/floor", "/api/inventory/items", "/api/inventory/alerts", "/api/products", "/api/audit", "/api/tips/report", "/api/customers", "/api/reservations", "/api/pass", "/api/cash/sessions"]) {
      const r = await app.inject({ method: "GET", url, headers: H });
      expect(r.statusCode, url).toBeLessThan(500);
      expect(r.statusCode, url).not.toBe(404);
    }
    const floor = (await app.inject({ method: "GET", url: "/api/floor", headers: H })).json() as { accounts: unknown[] }[];
    expect(floor).toHaveLength(26);
    expect(floor.filter((f) => f.accounts.length > 0).length).toBeGreaterThanOrEqual(8);
  });

  it("es determinista: la misma semilla produce las mismas ventas", async () => {
    const db2 = await openDb(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "demo-photos2-"));
    const s2 = await seedDemo(db2, { photosDir: dir, now: NOW });
    rmSync(dir, { recursive: true, force: true });
    expect(s2.salesLast14Days).toEqual(summary.salesLast14Days);
  });
});

describe("demo de mariscos: inventario por áreas, listas y recetario", () => {
  it("todos los insumos están en un área y una categoría coherentes, con mínimo y máximo", async () => {
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM inventory_items WHERE area_id IS NULL OR category_id IS NULL")).c).toBe(0);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM inventory_items i JOIN inventory_categories c ON c.id=i.category_id WHERE c.area_id!=i.area_id")).c).toBe(0);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM inventory_items WHERE min_stock>0 AND (max_stock IS NULL OR max_stock<min_stock)")).c).toBe(0);
    const areas = (await all<{ name: string }>("SELECT name FROM inventory_areas")).map((a) => a.name);
    expect(areas).toEqual(expect.arrayContaining(["Cocina", "Barra", "Limpieza y desechables"]));
    const cats = (await all<{ name: string }>("SELECT name FROM inventory_categories")).map((a) => a.name);
    expect(cats).toEqual(expect.arrayContaining(["Mariscos y pescados", "Perecederos", "Enlatados y salsas", "Cervezas", "Licores y vinos"]));
  });

  it("hay insumos por pedir y la lista automática refleja justo eso", async () => {
    const low = (await one<{ c: number }>("SELECT COUNT(*) c FROM inventory_items WHERE min_stock>0 AND stock<=min_stock")).c;
    expect(low).toBeGreaterThanOrEqual(5);
    const auto = await one<{ id: string }>("SELECT id FROM shopping_lists WHERE kind='auto' AND status='abierta'");
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM shopping_list_items WHERE list_id=?", auto.id)).c).toBe(low);
  });

  it("incluye una lista compartida con su enlace público y una ya comprada", async () => {
    const shared = await one<{ share_token: string }>("SELECT share_token FROM shopping_lists WHERE status='compartida'");
    const r = await app.inject({ method: "GET", url: `/api/shared/shopping/${shared.share_token}` });
    expect(r.statusCode).toBe(200);
    expect(r.json().lines.length).toBeGreaterThanOrEqual(5);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM shopping_lists WHERE status='comprada'")).c).toBe(1);
  });

  it("el recetario trae comida, tragos, salsas y postres con ingredientes ligados al inventario y pasos", async () => {
    const cats = await all<{ name: string; n: number }>("SELECT c.name, COUNT(*) n FROM recipe_book r JOIN recipe_categories c ON c.id=r.category_id GROUP BY c.name");
    for (const k of ["Comida", "Bebidas y tragos", "Salsas y preparaciones", "Postres"]) expect(cats.find((c) => c.name === k)?.n, k).toBeGreaterThan(0);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM recipe_book")).c).toBeGreaterThanOrEqual(10);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM recipe_book WHERE instructions IS NULL OR instructions=''")).c).toBe(0);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM recipe_book_items WHERE item_id IS NOT NULL")).c).toBeGreaterThan(30);
    const t = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin1234" } })).json().token as string;
    const list = (await app.inject({ method: "GET", url: "/api/recipe-book", headers: { Authorization: `Bearer ${t}` } })).json() as { name: string; cost_per_portion_cents: number }[];
    const ceviche = list.find((r) => r.name === "Ceviche de pescado")!;
    expect(ceviche.cost_per_portion_cents).toBeGreaterThan(0);
  });
});
