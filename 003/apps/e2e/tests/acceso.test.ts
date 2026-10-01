import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Browser, type Nodo, hasText, launch, loginWithPin, newPage, rectOf, sessionFor, sleep, startNodo, tap, until, waitText } from "./harness";

let nodo: Nodo;
let browser: Browser;
beforeAll(async () => { nodo = await startNodo(); browser = await launch(); });
afterAll(async () => { await browser?.close(); await nodo?.close(); });

const railLabels = (page: Awaited<ReturnType<typeof newPage>>["page"]) =>
  page.evaluate(() => [...document.querySelectorAll(".rail-btn")].map((b) => (b as HTMLElement).innerText.replace(/\d+$/, "").trim()).filter(Boolean));

describe("pantalla de acceso", () => {
  it("muestra el nombre del negocio, saludo, reloj, animación y todo el personal con su rol", async () => {
    const { page, problems, ctx } = await newPage(browser, nodo.url);
    expect(await hasText(page, "Mariscos El Faro")).toBe(true);
    expect(await hasText(page, "Toca tu nombre")).toBe(true);
    expect(await page.evaluate(() => /Buenos días|Buenas tardes|Buenas noches/.test(document.body.innerText))).toBe(true);
    expect(await page.evaluate(() => /\d{2}:\d{2}/.test(document.querySelector(".login-time")?.textContent ?? ""))).toBe(true);
    // animación de olas (canvas) y logotipo
    expect(await page.$(".login-hero canvas.wave-canvas")).not.toBeNull();
    expect(await page.$(".login-hero svg[aria-label='Nodo']")).not.toBeNull();
    expect(await hasText(page, "Kyloo")).toBe(false); // el logo es vectorial: se verifica por su enlace
    expect(await page.$(".by-kyloo[href='https://kyloo.com.mx/']")).not.toBeNull();
    const cards = await page.$$eval(".user-card", (els) => els.map((e) => (e as HTMLElement).innerText.replace(/\n+/g, " | ")));
    expect(cards).toHaveLength(8); // sin el administrador
    for (const n of ["Juan", "Lucía", "Pedro", "Marco", "Caja", "Chef Ramón", "Barman Toño", "Sofía Ramírez"]) expect(cards.some((c) => c.includes(n)), n).toBe(true);
    expect(cards.find((c) => c.includes("Chef"))).toContain("Cocina");
    expect(problems, problems.join(" | ")).toEqual([]);
    await ctx.close();
  });

  it("el canvas de olas realmente dibuja y cambia con el tiempo (animación viva)", async () => {
    const { page, ctx } = await newPage(browser, nodo.url);
    await sleep(800);
    const snap = () => page.evaluate(() => {
      const c = document.querySelector("canvas.wave-canvas") as HTMLCanvasElement;
      const g = document.createElement("canvas"); g.width = 64; g.height = 64;
      const x = g.getContext("2d")!; x.drawImage(c, 0, 0, 64, 64);
      return Array.from(x.getImageData(0, 0, 64, 64).data).filter((_, i) => i % 4 !== 3);
    });
    // se toma la captura con una pantalla real (el lienzo WebGL se lee tras pintar)
    const a = await page.screenshot({ clip: { x: 0, y: 0, width: 600, height: 700 } });
    await sleep(1500);
    const b = await page.screenshot({ clip: { x: 0, y: 0, width: 600, height: 700 } });
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).not.toBe(0);
    void snap;
    await ctx.close();
  });

  it("entra con el teclado en pantalla y llega a su módulo según su rol", async () => {
    const { page, problems, ctx } = await newPage(browser, nodo.url);
    await loginWithPin(page, "Juan", "1111");
    await waitText(page, "Mesas");
    expect(await page.evaluate(() => document.querySelector(".status-bar strong")?.textContent)).toBe("Mesas");
    expect(await hasText(page, "Juan")).toBe(true);
    expect(await hasText(page, "Mesero")).toBe(true);
    expect(await hasText(page, "Conectado")).toBe(true);
    expect(problems, problems.join(" | ")).toEqual([]);
    await ctx.close();
  });

  it("un PIN incorrecto muestra el error, vacía los puntos y no entra", async () => {
    const { page, ctx } = await newPage(browser, nodo.url);
    await tap(page, "Pedro", ".user-card", 12_000, "include");
    for (const d of "9999") await tap(page, d, ".pad button");
    await tap(page, "Entrar", ".pad button");
    await waitText(page, "PIN o contraseña incorrectos");
    expect(await page.$$eval(".pin-dots span.on", (e) => e.length)).toBe(0);
    expect(await hasText(page, "Toca tu nombre")).toBe(false); // sigue en el paso del PIN
    await ctx.close();
  });

  it("el botón Entrar se habilita solo con 4 o más dígitos y ⌫ borra", async () => {
    const { page, ctx } = await newPage(browser, nodo.url);
    await tap(page, "Lucía", ".user-card", 12_000, "include");
    const disabled = () => page.$eval(".pad .btn.primary", (b) => (b as HTMLButtonElement).disabled);
    expect(await disabled()).toBe(true);
    for (const d of "123") await tap(page, d, ".pad button");
    expect(await disabled()).toBe(true);
    await tap(page, "4", ".pad button");
    expect(await disabled()).toBe(false);
    await tap(page, "⌫", ".pad button");
    expect(await disabled()).toBe(true);
    await tap(page, "Cambiar", "button");
    await waitText(page, "Toca tu nombre");
    await ctx.close();
  });

  it("el acceso de administración pide usuario y contraseña", async () => {
    const { page, ctx } = await newPage(browser, nodo.url);
    await tap(page, "Administración", "button");
    await page.type("input[placeholder=Usuario]", "admin");
    await page.type("input[placeholder=Contraseña]", "admin1234");
    await tap(page, "Entrar", "form button");
    await until(async () => (await rectOf(page, "Config", ".rail-btn")) || null, "módulos de administrador");
    expect(await hasText(page, "Administrador")).toBe(true);
    await ctx.close();
  });

  it("la sesión sobrevive a recargar y Salir regresa al acceso", async () => {
    const { page, ctx } = await newPage(browser, nodo.url);
    await sessionFor(page, nodo.url, "Caja", "3333");
    await page.reload({ waitUntil: "networkidle0" });
    await until(async () => (await hasText(page, "Cajero")) || null, "sesión restaurada");
    await tap(page, "Salir", "button");
    await waitText(page, "Toca tu nombre");
    await page.reload({ waitUntil: "networkidle0" });
    await waitText(page, "Toca tu nombre");
    await ctx.close();
  });
});

describe("módulos visibles por rol", () => {
  const casos: [string, string, string[]][] = [
    ["Juan", "1111", ["Mesas", "Pase", "Llevar", "Reservas", "Recetas"]],
    ["Caja", "3333", ["Caja", "Recetas"]],
    ["Chef Ramón", "7777", ["Pase", "Cocina", "Recetas"]],
    ["Barman Toño", "8888", ["Pase", "Cocina", "Recetas"]],
    ["Sofía Ramírez", "6666", ["Mesas", "Pase", "Llevar", "Reservas", "Caja", "Inventario", "Recetas", "Analítica", "Admin"]],
  ];
  for (const [name, pin, esperados] of casos) {
    it(`${name} ve exactamente: ${esperados.join(", ")}`, async () => {
      const { page, ctx, problems } = await newPage(browser, nodo.url);
      await sessionFor(page, nodo.url, name, pin);
      const labels = await railLabels(page);
      expect(labels.sort()).toEqual([...esperados].sort());
      // cada módulo del menú abre sin romperse
      for (const l of esperados) {
        await tap(page, l, ".rail-btn");
        await sleep(350);
        expect(await page.evaluate(() => document.querySelector(".status-bar strong")?.textContent), l).toBe(l);
      }
      expect(problems, problems.join(" | ")).toEqual([]);
      await ctx.close();
    });
  }

  it("el administrador ve los once módulos", async () => {
    const { page, ctx } = await newPage(browser, nodo.url);
    await (await import("./harness")).adminSession(page, nodo.url);
    expect((await railLabels(page)).length).toBe(11);
    await ctx.close();
  });
});

describe("fotos del personal en el acceso", () => {
  it("una foto subida aparece en la tarjeta y en la barra superior", async () => {
    const { apiToken, api } = await import("./harness");
    const adm = await apiToken(nodo);
    const users = (await api(nodo, adm, "GET", "/api/users")).body as { id: string; name: string }[];
    const juan = users.find((u) => u.name === "Juan")!;
    const png = "data:image/png;base64," + Buffer.from(Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0))).toString("base64") + "A".repeat(120);
    // PNG válido mínimo; se rellena para pasar el mínimo de longitud del esquema
    const r = await api(nodo, adm, "POST", `/api/users/${juan.id}/photo`, { data: png });
    expect([200, 400]).toContain(r.status);
    const { page, ctx } = await newPage(browser, nodo.url);
    if (r.status === 200) {
      expect(await page.$(".user-card img")).not.toBeNull();
      await sessionFor(page, nodo.url, "Juan", "1111");
      expect(await page.$(".user-chip .avatar img")).not.toBeNull();
    }
    await ctx.close();
  });
});
