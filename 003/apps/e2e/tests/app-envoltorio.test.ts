import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Browser,
  type Nodo,
  WEB_DIST,
  hasText,
  launch,
  newPage,
  settle,
  startNodo,
  tap,
  until,
  waitText,
} from "./harness";

/**
 * La app envoltorio de las tablets lleva la interfaz dentro y habla con el servidor del local por la red. Se simula con la
 * interfaz servida desde OTRO origen (como los archivos de la app) y el servidor real en el suyo.
 */
let nodo: Nodo;
let ui: Server;
let uiUrl = "";
let browser: Browser;
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

beforeAll(async () => {
  // Los archivos de la app se sirven desde un puerto distinto del servidor: el servidor debe aceptarlo por CORS
  ui = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const file = join(WEB_DIST, path === "/" ? "index.html" : path);
    const real = existsSync(file) && statSync(file).isFile() ? file : join(WEB_DIST, "index.html");
    res.setHeader("content-type", MIME[extname(real)] ?? "application/octet-stream");
    createReadStream(real).pipe(res);
  });
  await new Promise<void>((r) => ui.listen(0, "127.0.0.1", () => r()));
  uiUrl = `http://127.0.0.1:${(ui.address() as { port: number }).port}`;
  process.env.NODO_CORS_ORIGINS = uiUrl;
  nodo = await startNodo();
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
  await nodo?.close().catch(() => undefined);
  ui?.close();
  // biome-ignore lint/performance/noDelete: process.env no admite undefined como valor
  delete process.env.NODO_CORS_ORIGINS;
});

const asNativeApp = (page: Awaited<ReturnType<typeof newPage>>["page"]) =>
  page.evaluateOnNewDocument(() => {
    (window as unknown as { Capacitor: unknown }).Capacitor = { isNativePlatform: () => true };
  });

describe("interfaz de la app envoltorio", () => {
  it("la primera vez pide el servidor, rechaza una dirección equivocada y conecta con la correcta", async () => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(String(e)));
    await asNativeApp(page);
    await page.goto(uiUrl, { waitUntil: "networkidle0" });
    await waitText(page, "Conectar con el servidor");

    // una dirección donde no hay nada: se explica, no se queda colgada
    await tap(page, "Dirección", "input");
    await page.keyboard.type("127.0.0.1:9", { delay: 5 });
    await tap(page, "Conectar", "button");
    await until(
      async () => (await hasText(page, "No se pudo conectar")) || null,
      "error de conexión",
      15_000,
    );

    // la correcta (solo la IP y el puerto)
    await tap(page, "Dirección", "input");
    await page.evaluate(() => (document.activeElement as HTMLInputElement).select());
    await page.keyboard.type(new URL(nodo.url).host, { delay: 5 });
    await tap(page, "Conectar", "button");
    await waitText(page, "Toca tu nombre");
    expect(await page.evaluate(() => localStorage.getItem("003.server"))).toBe(nodo.url);
    expect(problems).toEqual([]);
    await ctx.close();
  });

  it("entra, trabaja contra el servidor remoto y, si el servidor se cae, la interfaz sigue abriendo", async () => {
    const ctx = await newPage(browser, uiUrl);
    const page = ctx.page;
    await page.evaluateOnNewDocument(() => {
      (window as unknown as { Capacitor: unknown }).Capacitor = { isNativePlatform: () => true };
    });
    await page.evaluate((u) => localStorage.setItem("003.server", u), nodo.url);
    await page.reload({ waitUntil: "networkidle0" });
    await waitText(page, "Toca tu nombre");
    await tap(page, "Juan", ".user-card", 12_000, "include");
    for (const d of "1111") await tap(page, d, ".pad button");
    await tap(page, "Entrar", ".pad button");
    await until(async () => (await hasText(page, "libres")) || null, "mapa de mesas", 20_000);
    // las fotos y datos vienen del servidor, no del origen de la app
    const imgs = await page.$$eval("img", (els) =>
      els.map((e) => (e as HTMLImageElement).src).filter((s) => s.includes("/api/photos/")),
    );
    for (const src of imgs) expect(src.startsWith(nodo.url)).toBe(true);
    expect(ctx.problems.filter((p) => !/401/.test(p))).toEqual([]);

    // se apaga el servidor del local: la interfaz (que es de la app) abre igual, con lo último que conocía y el aviso
    await nodo.close();
    await page.reload({ waitUntil: "load" });
    await until(
      async () => (await hasText(page, "libres")) || null,
      "mapa de mesas desde la memoria",
      20_000,
    );
    await until(
      async () => (await hasText(page, "Sin conexión")) || null,
      "aviso de sin conexión",
      20_000,
    );
    await ctx.ctx.close();
  });
});
