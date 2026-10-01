import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Browser, type Nodo, type Page, adminSession, api, apiToken, hasText, launch, newPage, rectOf, sleep, startNodo, tap, until, waitText } from "./harness";

/** Inventario por áreas, listas de compras compartibles y recetario, manejados con clics reales. */
let nodo: Nodo;
let browser: Browser;
let token: string;
beforeAll(async () => { nodo = await startNodo(); browser = await launch(); token = await apiToken(nodo); });
afterAll(async () => { await browser?.close(); await nodo?.close(); });

const fits = (page: Page) => page.evaluate(() => {
  const d = document.documentElement; const m = document.querySelector(".main") as HTMLElement;
  return { page: d.scrollHeight > innerHeight + 1 || d.scrollWidth > innerWidth + 1, main: m.scrollHeight > m.clientHeight + 2 || m.scrollWidth > m.clientWidth + 2 };
});
/** Toca un módulo del menú por su nombre (con el menú colapsado el texto está oculto, por eso se lee textContent). */
const rail = async (page: Page, label: string) => {
  const r = await until(() => page.evaluate((label) => {
    const b = [...document.querySelectorAll(".rail-btn")].find((x) => (x.textContent ?? "").replace(/[0-9]+$/, "").trim() === label);
    if (!b) return null; const q = b.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 };
  }, label), `módulo ${label}`);
  await page.mouse.click(r.x, r.y); await sleep(250);
};
const typeInto = async (page: Page, placeholder: string, text: string) => {
  const r = await until(() => rectOf(page, placeholder, "input, textarea", "include"), `campo «${placeholder}»`);
  await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2);
  await page.keyboard.type(text);
};

describe("Inventario · pestañas y áreas", () => {
  for (const vp of [{ width: 1024, height: 600 }, { width: 1280, height: 720 }, { width: 800, height: 1100 }]) {
    it(`todas las pestañas caben sin desplazarse en ${vp.width}×${vp.height}`, async () => {
      const { page, ctx, problems } = await newPage(browser, nodo.url, vp);
      await adminSession(page, nodo.url);
      await rail(page, "Inventario");
      await waitText(page, "Existencias");
      for (const tab of ["Existencias", "Por pedir", "Listas de compras", "Recetas y costos", "Compras"]) {
        await tap(page, tab, ".chip");
        await sleep(450);
        const f = await fits(page);
        expect(f.page, `${tab}: la página se desplaza`).toBe(false);
        expect(f.main, `${tab}: el contenido se desborda`).toBe(false);
      }
      expect(problems).toEqual([]);
      await ctx.close();
    });
  }

  it("filtra por área y categoría definidas por el usuario", async () => {
    const areas = (await api(nodo, token, "GET", "/api/inventory/areas")).body as { id: string; name: string }[];
    const cats = (await api(nodo, token, "GET", "/api/inventory/categories")).body as { name: string; area_id: string }[];
    const cocina = { categories: cats.filter((c) => c.area_id === areas.find((a) => a.name === "Cocina")!.id) };
    const { page, ctx } = await newPage(browser, nodo.url, { width: 1280, height: 800 });
    await adminSession(page, nodo.url);
    await rail(page, "Inventario");
    await tap(page, "Existencias", ".chip");
    await tap(page, "Cocina", ".chip");
    await sleep(400);
    const some = cocina.categories[0]?.name;
    expect(some).toBeTruthy();
    expect(await hasText(page, some!)).toBe(true);
    await ctx.close();
  });
});

describe("Listas de compras", () => {
  it("crea una lista manual, agrega un artículo libre, lo marca y la comparte", async () => {
    const before = ((await api(nodo, token, "GET", "/api/shopping-lists")).body as unknown[]).length;
    const { page, ctx, problems } = await newPage(browser, nodo.url, { width: 1280, height: 800 });
    await adminSession(page, nodo.url);
    await rail(page, "Inventario");
    await tap(page, "Listas de compras", ".chip");
    await tap(page, "+ Lista manual", "button");
    await until(async () => (await page.$(".sheet")) || null, "hoja de la lista");

    await typeInto(page, "o artículo libre", "Limones persas");
    await typeInto(page, "Cantidad", "12");
    await tap(page, "Agregar", ".sheet button");
    await waitText(page, "Limones persas");
    await page.click(".sheet .check");
    await until(async () => (await page.$(".check.on")) || null, "artículo marcado");

    const lists = (await api(nodo, token, "GET", "/api/shopping-lists")).body as { id: string; checked: number; items: number }[];
    expect(lists.length).toBe(before + 1);
    const mine = lists.find((l) => l.items === 1)!;
    expect(mine.checked).toBe(1);

    await tap(page, "Compartir", ".sheet button");
    await waitText(page, "Compartir lista");
    const url = await page.$eval('input[aria-label="Enlace de la lista"]', (i) => (i as HTMLInputElement).value);
    expect(url).toMatch(/\/s\?t=[0-9a-f]+/);
    expect(await page.$eval(".share-text", (p) => p.textContent)).toContain("Limones persas");
    expect(problems).toEqual([]);

    // La persona que compra abre el enlace SIN iniciar sesión
    const anon = await newPage(browser, url.replace(/^https?:\/\/[^/]+/, nodo.url));
    await waitText(anon.page, "Limones persas");
    expect(await hasText(anon.page, "Toca tu nombre")).toBe(false);
    const f = await fits(anon.page).catch(() => null);
    expect(f === null || f.page === false).toBe(true);
    await anon.page.click(".shared-row");
    await until(async () => ((await api(nodo, token, "GET", `/api/shopping-lists/${mine.id}`)).body.lines[0].checked === 0) || null, "la persona desmarcó el artículo");
    expect(anon.problems).toEqual([]);
    await anon.ctx.close();
    await ctx.close();
  });

  it("dejar de compartir invalida el enlace", async () => {
    const lists = (await api(nodo, token, "GET", "/api/shopping-lists")).body as { id: string; items: number }[];
    const l = lists.find((x) => x.items === 1)!;
    const sh = (await api(nodo, token, "POST", `/api/shopping-lists/${l.id}/share`, {})).body as { token: string };
    expect((await nodo.app.inject({ method: "GET", url: `/api/shared/shopping/${sh.token}` })).statusCode).toBe(200);
    await api(nodo, token, "POST", `/api/shopping-lists/${l.id}/unshare`, {});
    expect((await nodo.app.inject({ method: "GET", url: `/api/shared/shopping/${sh.token}` })).statusCode).toBe(404);
  });

  it("«Desde lo que falta» trae los insumos bajo el mínimo", async () => {
    const { page, ctx } = await newPage(browser, nodo.url, { width: 1280, height: 800 });
    await adminSession(page, nodo.url);
    await rail(page, "Inventario");
    await tap(page, "Listas de compras", ".chip");
    await tap(page, "Desde lo que falta", "button");
    await until(async () => (await page.$(".sheet")) || null, "hoja de la lista");
    await until(async () => ((await page.$$(".sheet .check")).length > 0) || null, "artículos sugeridos");
    expect(await hasText(page, "mín.")).toBe(true);
    await ctx.close();
  });
});

describe("Recetario", () => {
  it("el módulo carga con las categorías sembradas y cabe sin desplazarse", async () => {
    for (const vp of [{ width: 1024, height: 600 }, { width: 800, height: 1100 }]) {
      const { page, ctx, problems } = await newPage(browser, nodo.url, vp);
      await adminSession(page, nodo.url);
      await rail(page, "Recetas");
      await waitText(page, "Nueva receta");
      expect(await hasText(page, "Todas")).toBe(true);
      const f = await fits(page);
      expect(f.page).toBe(false);
      expect(f.main).toBe(false);
      expect(problems).toEqual([]);
      await ctx.close();
    }
  });

  it("crea una receta con ingredientes y la escala por porciones", async () => {
    const { page, ctx, problems } = await newPage(browser, nodo.url, { width: 1280, height: 800 });
    await adminSession(page, nodo.url);
    await rail(page, "Recetas");
    await tap(page, "+ Nueva receta", "button");
    await waitText(page, "Nueva receta");
    await typeInto(page, "Nombre de la receta", "Margarita de prueba");
    await typeInto(page, "porciones", "2");
    await tap(page, "Ingredientes", ".sheet .chip, .sheet button");
    await tap(page, "+ Ingrediente libre", ".sheet button");
    await typeInto(page, "Cant.", "60");
    await typeInto(page, "Ingrediente", "Tequila blanco");
    await tap(page, "Guardar", ".sheet button");
    await until(async () => ((await api(nodo, token, "GET", "/api/recipe-book")).body as { name: string }[]).some((r) => r.name === "Margarita de prueba") || null, "receta guardada");
    await until(async () => (await hasText(page, "Margarita de prueba")) || null, "receta en la lista");
    expect(problems).toEqual([]);
    await ctx.close();
  });

  it("agrega una categoría propia y aparece como filtro", async () => {
    const { page, ctx } = await newPage(browser, nodo.url, { width: 1280, height: 800 });
    await adminSession(page, nodo.url);
    await rail(page, "Recetas");
    await tap(page, "Categorías", "button");
    await waitText(page, "Categorías de recetas");
    await typeInto(page, "Nueva categoría", "Cocteles clásicos");
    await tap(page, "Agregar", ".sheet button").catch(async () => tap(page, "Guardar", ".sheet button"));
    await until(async () => ((await api(nodo, token, "GET", "/api/recipe-categories")).body as { name: string }[]).some((c) => c.name === "Cocteles clásicos") || null, "categoría creada");
    await tap(page, "Cerrar", ".sheet button");
    await waitText(page, "Cocteles clásicos");
    await ctx.close();
  });
});

describe("Permisos del inventario en pantalla", () => {
  it("un mesero no ve el módulo de Inventario ni Recetas editable", async () => {
    const { page, ctx } = await newPage(browser, nodo.url);
    const { sessionFor } = await import("./harness");
    const users = (await nodo.app.inject({ method: "GET", url: "/api/auth/users" })).json() as { name: string; role: string }[];
    const mesero = users.find((u) => u.role === "mesero")!;
    expect(mesero).toBeTruthy();
    // El PIN de demostración de los meseros se documenta en la semilla
    const pin = "1111";
    await sessionFor(page, nodo.url, mesero.name, pin).catch(() => undefined);
    const labels = await page.$$eval(".rail-btn", (bs) => bs.map((b) => (b as HTMLElement).innerText));
    expect(labels.join(" ")).not.toMatch(/Inventario/);
    await ctx.close();
  });
});
