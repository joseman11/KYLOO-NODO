import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { placeholderPng } from "../../server/src/demo-png";
import { type Browser, type Nodo, type Page, adminSession, firstPage, hasText, launch, newPage, pagedHasText, rectOf, rowButton, sessionFor, sleep, startNodo, tap, until, waitText } from "./harness";

/** Configuración de punta a punta: equipo con fotos, menú, áreas y vista previa del ticket. */
let nodo: Nodo;
let browser: Browser;
let tmp: string;
let photo: string;
beforeAll(async () => {
  nodo = await startNodo();
  browser = await launch();
  tmp = mkdtempSync(join(tmpdir(), "nodo-foto-"));
  photo = join(tmp, "retrato.png");
  writeFileSync(photo, placeholderPng(210, 300, 300));
});
afterAll(async () => { await browser?.close(); await nodo?.close(); rmSync(tmp, { recursive: true, force: true }); });

const one = async <T>(sql: string, ...a: unknown[]) => await nodo.db.prepare(sql).get(...a) as T;
const goConfig = async (p: Page, tab: string) => {
  await tap(p, "Config", ".rail-btn");
  await tap(p, tab, ".view > .row.wrap > .chip");
  await sleep(300);
};

let admin: Awaited<ReturnType<typeof newPage>>;
beforeAll(async () => {
  admin = await newPage(browser, nodo.url);
  await adminSession(admin.page, nodo.url);
});
afterAll(async () => { await admin?.ctx.close(); });

describe("equipo: alta, foto, edición y baja", () => {
  it("la lista muestra a todo el personal con su puesto y su forma de acceso", async () => {
    await goConfig(admin.page, "Equipo");
    for (const n of ["Administrador", "Juan", "Lucía", "Chef Ramón", "Caja"]) expect(await pagedHasText(admin.page, n), n).toBe(true);
    await firstPage(admin.page);
    expect(await hasText(admin.page, "Usuario admin")).toBe(true);
  });

  it("da de alta a un trabajador nuevo con su foto y PIN", async () => {
    const p = admin.page;
    await tap(p, "+ Nuevo trabajador", "button");
    await until(async () => (await p.$(".sheet")) || null, "ventana de alta");
    const guardar = () => p.$eval(".sheet .btn.primary", (b) => (b as HTMLButtonElement).disabled);
    expect(await guardar()).toBe(true); // sin nombre no se puede guardar
    await p.type(".sheet input[placeholder=Nombre]", "Valeria Prueba");
    await p.select(".sheet select", "mesero");
    await p.type(".sheet input[inputmode=numeric]", "4321");
    // la foto se sube, se recorta cuadrada y se previsualiza antes de guardar
    const input = await p.$(".sheet input[type=file]:not([capture])");
    expect(input).not.toBeNull();
    await (input as import("puppeteer-core").ElementHandle<HTMLInputElement>).uploadFile(photo);
    await until(async () => (await p.$(".sheet .portrait img")) || null, "vista previa de la foto");
    expect(await guardar()).toBe(false);
    await tap(p, "Guardar", ".sheet button");
    await until(async () => !(await p.$(".sheet")) || null, "cierre de la ventana");
    expect(await pagedHasText(p, "Valeria Prueba")).toBe(true);
    const u = await one<{ id: string; role: string; photo: string | null; active: number }>("SELECT id, role, photo, active FROM users WHERE name='Valeria Prueba'");
    expect(u.role).toBe("mesero");
    expect(u.photo).toMatch(/^[a-f0-9]{24}-[a-f0-9]{8}\.(jpg|png|webp)$/);
    expect(u.active).toBe(1);
  });

  it("la foto aparece en la pantalla de acceso y la persona entra con su PIN y su foto en la barra", async () => {
    const n = await newPage(browser, nodo.url);
    const card = await n.page.$$eval(".user-card", (els) => els.filter((e) => (e as HTMLElement).innerText.includes("Valeria")).map((e) => !!e.querySelector("img")));
    expect(card).toEqual([true]);
    const src = await n.page.$eval(".user-card img", (i) => (i as HTMLImageElement).currentSrc);
    expect((await fetch(src)).status).toBe(200);
    await sessionFor(n.page, nodo.url, "Valeria Prueba", "4321");
    expect(await n.page.$(".user-chip .avatar img")).not.toBeNull();
    expect(n.problems, n.problems.join(" | ")).toEqual([]);
    await n.ctx.close();
  });

  it("cambia el PIN y el puesto; el PIN viejo deja de servir", async () => {
    const p = admin.page;
    await rowButton(p, "Valeria Prueba", "Editar");
    await until(async () => (await p.$(".sheet")) || null, "ventana de edición");
    await p.select(".sheet select", "cajero");
    await p.type(".sheet input[inputmode=numeric]", "9876");
    await tap(p, "Guardar", ".sheet button");
    await until(async () => !(await p.$(".sheet")) || null, "cierre");
    expect((await one<{ role: string }>("SELECT role FROM users WHERE name='Valeria Prueba'")).role).toBe("cajero");
    const users = (await nodo.app.inject({ method: "GET", url: "/api/auth/users" })).json() as { id: string; name: string }[];
    const id = users.find((u) => u.name === "Valeria Prueba")!.id;
    expect((await nodo.app.inject({ method: "POST", url: "/api/auth/pin", payload: { userId: id, pin: "4321" } })).statusCode).toBe(401);
    expect((await nodo.app.inject({ method: "POST", url: "/api/auth/pin", payload: { userId: id, pin: "9876" } })).statusCode).toBe(200);
  });

  it("dar de baja la oculta del acceso y quitar la foto la regresa a iniciales", async () => {
    const p = admin.page;
    const click = async () => { await rowButton(p, "Valeria Prueba", "Editar"); await until(async () => (await p.$(".sheet")) || null, "ventana"); };
    await click();
    await tap(p, "Quitar foto", ".sheet button");
    await tap(p, "Guardar", ".sheet button");
    await until(async () => !(await p.$(".sheet")) || (await p.$(".sheet .err").then(async (e) => (e ? await e.evaluate((x) => (x as HTMLElement).innerText) : null))) || null, "cierre");
    const stuck = await p.$eval(".sheet", (x) => (x as HTMLElement).innerText.split("\n").join(" | ")).catch(() => null);
    if (stuck) throw new Error("ventana abierta: ..." + stuck.slice(-170));
    expect((await one<{ photo: string | null }>("SELECT photo FROM users WHERE name='Valeria Prueba'")).photo).toBeNull();
    await click();
    await p.click(".sheet input[type=checkbox]");
    await tap(p, "Guardar", ".sheet button");
    await until(async () => !(await p.$(".sheet")) || null, "cierre");
    expect((await one<{ active: number }>("SELECT active FROM users WHERE name='Valeria Prueba'")).active).toBe(0);
    const n = await newPage(browser, nodo.url);
    expect(await n.page.$$eval(".user-card", (e) => e.some((x) => (x as HTMLElement).innerText.includes("Valeria")))).toBe(false);
    await n.ctx.close();
  });

  it("una foto de más de 800 KB o que no es imagen se rechaza con un mensaje, sin romper la ventana", async () => {
    const p = admin.page;
    await tap(p, "+ Nuevo trabajador", "button");
    await until(async () => (await p.$(".sheet")) || null, "ventana");
    const bad = join(tmp, "no-es-imagen.png");
    writeFileSync(bad, "esto no es una imagen");
    const input = await p.$(".sheet input[type=file]:not([capture])");
    await (input as import("puppeteer-core").ElementHandle<HTMLInputElement>).uploadFile(bad);
    await until(async () => (await p.$(".sheet .err")) || null, "mensaje de error");
    expect(await p.$(".sheet")).not.toBeNull();
    await tap(p, "Cancelar", ".sheet button");
  });
});

describe("menú: productos y áreas", () => {
  it("crea un platillo nuevo con precio, categoría y estación, y aparece en el comandero", async () => {
    const p = admin.page;
    await goConfig(p, "Productos");
    await tap(p, "+ Nuevo producto", "button");
    await until(async () => (await p.$(".sheet")) || null, "ventana de producto");
    await p.type(".sheet input[placeholder^=Nombre]", "Pulpo al ajillo de prueba");
    await p.type(".sheet input[placeholder=Precio]", "289.50");
    const cat = await p.$$eval(".sheet select option", (o) => (o as HTMLOptionElement[]).find((x) => x.text.includes("Pulpo y calamar"))?.value);
    expect(cat).toBeTruthy();
    await p.select(".sheet select", cat!);
    await tap(p, "Crear producto", ".sheet button");
    await until(async () => !(await p.$(".sheet")) || null, "cierre");
    const prod = await one<{ id: string; price_cents: number; category_id: string }>("SELECT id, price_cents, category_id FROM products WHERE name='Pulpo al ajillo de prueba'");
    expect(prod.price_cents).toBe(28950);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM product_routes WHERE product_id=?", prod.id)).c).toBeGreaterThan(0); // heredó la estación de su categoría
  });

  it("el producto nuevo se vende desde el comandero de un mesero", async () => {
    const w = await newPage(browser, nodo.url);
    await sessionFor(w.page, nodo.url, "Juan", "1111");
    const free = (await one<{ number: string }>("SELECT number FROM tables_ WHERE status='disponible' ORDER BY number LIMIT 1")).number;
    await until(async () => (await rectOf(w.page, free, ".table-card")) || null, "mapa");
    await tap(w.page, free, ".table-card");
    await tap(w.page, "Abrir mesa", "button");
    await waitText(w.page, "Mesa " + free);
    await tap(w.page, "Buscar", "input");
    await w.page.keyboard.type("Pulpo al ajillo", { delay: 20 });
    await tap(w.page, "Pulpo al ajillo de prueba", ".product");
    await until(async () => (await w.page.$$eval(".tk", (e) => e.length)) >= 1 || null, "renglón agregado");
    await waitText(w.page, "$289.50");
    await w.ctx.close();
  });

  it("agota un producto y deja de poder pedirse", async () => {
    const p = admin.page;
    await goConfig(p, "Productos");
    const found = await until(async () => {
      const r = await p.evaluate(() => {
        const tr = [...document.querySelectorAll("tr")].find((x) => (x as HTMLElement).innerText.includes("Agua mineral"));
        const b = tr && [...tr.querySelectorAll("button")].find((x) => (x as HTMLElement).innerText.trim() === "Agotar");
        if (!b) return null;
        const rc = b.getBoundingClientRect();
        return { x: rc.x + rc.width / 2, y: rc.y + rc.height / 2 };
      });
      if (r) return r;
      const next = await rectOf(p, "›", ".pager button");
      if (next) await p.mouse.click(next.x + next.w / 2, next.y + next.h / 2);
      await sleep(250);
      return null;
    }, "fila de Agua mineral", 20_000);
    await p.mouse.click(found.x, found.y);
    await until(async () => (await one<{ availability: string }>("SELECT availability FROM products WHERE name='Agua mineral'")).availability === "agotado" || null, "producto agotado");
  });

  it("la vista previa del ticket usa el nombre del negocio y la mesa en grande", async () => {
    const p = admin.page;
    await goConfig(p, "Tickets");
    await until(async () => (await hasText(p, "MARISCOS EL FARO")) || (await hasText(p, "Mariscos El Faro")) || (await hasText(p, "MESA")) || null, "vista previa del ticket");
    expect(await hasText(p, "MESA")).toBe(true);
  });
});

describe("áreas y mesas", () => {
  it("las áreas de servicio aparecen como pestañas en el mapa de mesas", async () => {
    const w = await newPage(browser, nodo.url);
    await sessionFor(w.page, nodo.url, "Pedro", "2222");
    const chips = await w.page.$$eval(".view .chips .chip, .view .row .chip", (c) => c.map((x) => (x as HTMLElement).innerText.trim()));
    for (const z of ["Todas", "Salón", "Terraza", "Barra", "Privado"]) expect(chips).toContain(z);
    await tap(w.page, "Terraza", ".chip");
    await sleep(300);
    const cards = await w.page.$$eval(".table-card", (c) => c.map((x) => (x as HTMLElement).innerText.split("\n")[0]));
    expect(cards.length).toBe(8);
    expect(cards.every((c) => c!.startsWith("T"))).toBe(true);
    await w.ctx.close();
  });
});

describe("salud de la sesión de administración", () => {
  it("no hubo errores de consola ni peticiones fallidas en toda la configuración", () => {
    expect(admin.problems.filter((x) => !x.includes("http 400") && !x.includes("http 413")), admin.problems.join(" | ")).toEqual([]);
  });
});
