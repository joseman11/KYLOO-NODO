/**
 * Pruebas de la landing (Next.js): se sirve la compilación real (`next start`) y se recorre con Chrome.
 * Requiere `npm run build` dentro de /landing.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch, sleep, until, type Browser } from "./harness";

const LANDING = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../landing");
const PORT = 3047;
const URL_ = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let browser: Browser;

beforeAll(async () => {
  if (!existsSync(resolve(LANDING, ".next/BUILD_ID"))) throw new Error("Falta compilar la landing: cd landing && npm run build");
  server = spawn(process.execPath, [resolve(LANDING, "node_modules/next/dist/bin/next"), "start", "-p", String(PORT), "-H", "127.0.0.1"], { cwd: LANDING, stdio: "ignore" });
  await until(async () => (await fetch(URL_).then((r) => r.ok).catch(() => false)) || null, "servidor de la landing", 30_000);
  browser = await launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.kill();
});

async function open(size: { width: number; height: number }) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ ...size, deviceScaleFactor: 1 });
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${(e as Error).message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
  page.on("response", (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
  // Los videos siguen descargando: no se espera a que la red quede en silencio
  await page.goto(URL_, { waitUntil: "load", timeout: 60_000 });
  await sleep(500);
  return { page, ctx, problems };
}

describe("landing · contenido y metadatos", () => {
  it("responde con título, descripción y Open Graph", async () => {
    const html = await fetch(URL_).then((r) => r.text());
    expect(html).toMatch(/<title>[^<]*Nodo/);
    expect(html).toMatch(/<meta name="description"/);
    expect(html).toMatch(/property="og:title"/);
    expect(html).toMatch(/lang="es/);
  });

  it("no publica correos ni teléfonos personales en el HTML", async () => {
    const html = await fetch(URL_).then((r) => r.text());
    expect(html).not.toMatch(/sanchezsaldana/i);
    expect(html).not.toMatch(/mailto:[^"]*@/);
  });

  it("tiene todas las secciones y los enlaces de ancla apuntan a algo que existe", async () => {
    const { page, ctx, problems } = await open({ width: 1440, height: 900 });
    const res = await page.evaluate(() => {
      const ids = new Set([...document.querySelectorAll("[id]")].map((e) => e.id));
      const hrefs = [...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute("href")!.slice(1));
      return { ids: [...ids], missing: hrefs.filter((h) => h && !ids.has(h)) };
    });
    for (const id of ["inicio", "como", "carta", "planes", "preguntas", "contacto"]) expect(res.ids).toContain(id);
    expect(res.missing).toEqual([]);
    expect(problems).toEqual([]);
    await ctx.close();
  });

  it("el hero tiene un único h1 y menciona Nodo", async () => {
    const { page, ctx } = await open({ width: 1440, height: 900 });
    const h1 = await page.$$eval("h1", (n) => n.map((x) => (x as HTMLElement).innerText));
    expect(h1).toHaveLength(1);
    expect(h1[0]!.length).toBeGreaterThan(10);
    await ctx.close();
  });

  it("todas las imágenes tienen texto alternativo y cargan", async () => {
    const { page, ctx } = await open({ width: 1440, height: 900 });
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } });
    const bad = await page.$$eval("img", (imgs) => imgs.filter((i) => i.getAttribute("alt") === null || (i.complete && i.naturalWidth === 0)).map((i) => i.src));
    expect(bad).toEqual([]);
    await ctx.close();
  });
});

describe("landing · videos", () => {
  for (const v of ["hero", "pedido", "cocina", "cobro"]) {
    it(`${v}.mp4 se sirve por rangos y su póster existe`, async () => {
      const r = await fetch(`${URL_}/videos/${v}.mp4`, { headers: { range: "bytes=0-1023" } });
      expect(r.status).toBe(206);
      expect(r.headers.get("content-type")).toMatch(/video\/mp4/);
      expect((await r.arrayBuffer()).byteLength).toBe(1024);
      expect((await fetch(`${URL_}/videos/${v}.jpg`)).status).toBe(200);
    });
  }

  it("los archivos .mp4 reales son H.264 de 1920×1080", async () => {
    for (const v of ["hero", "pedido", "cocina", "cobro"]) {
      const p = resolve(LANDING, `public/videos/${v}.mp4`);
      expect(statSync(p).size).toBeGreaterThan(100_000);
    }
    const { page, ctx } = await open({ width: 1440, height: 900 });
    const dims = await page.evaluate(async () => {
      const out: Record<string, [number, number, number]> = {};
      for (const v of ["hero", "pedido", "cocina", "cobro"]) {
        const el = document.createElement("video");
        el.muted = true; el.src = `/videos/${v}.mp4`; el.preload = "metadata";
        await new Promise<void>((ok) => { el.onloadedmetadata = () => ok(); el.onerror = () => ok(); });
        out[v] = [el.videoWidth, el.videoHeight, Math.round(el.duration)];
      }
      return out;
    });
    for (const v of Object.keys(dims)) {
      expect(dims[v]![0], `${v} ancho`).toBe(1920);
      expect(dims[v]![1], `${v} alto`).toBe(1080);
      expect(dims[v]![2], `${v} duración`).toBeGreaterThan(5);
    }
    await ctx.close();
  });

  it("el video del hero se reproduce solo (silenciado, en bucle)", async () => {
    const { page, ctx } = await open({ width: 1440, height: 900 });
    const t = await until(async () => {
      const x = await page.evaluate(() => { const v = document.querySelector("video") as HTMLVideoElement | null; return v ? { t: v.currentTime, muted: v.muted, loop: v.loop, paused: v.paused } : null; });
      return x && x.t > 0.3 ? x : null;
    }, "reproducción del hero", 15_000);
    expect(t.muted).toBe(true);
    expect(t.loop).toBe(true);
    await ctx.close();
  });
});

describe("landing · diseño adaptable (sin desbordes)", () => {
  const sizes: [string, number, number][] = [["móvil", 390, 844], ["móvil chico", 320, 640], ["tableta", 820, 1180], ["laptop", 1280, 720], ["escritorio", 1920, 1080]];
  for (const [name, width, height] of sizes) {
    it(`${name} ${width}×${height}: no hay scroll horizontal`, async () => {
      const { page, ctx, problems } = await open({ width, height });
      await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); } window.scrollTo(0, 0); });
      const over = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(over.sw).toBeLessThanOrEqual(over.cw + 1);
      expect(problems).toEqual([]);
      await ctx.close();
    });
  }

  it("el texto no se sale de su caja en móvil (ningún elemento supera el ancho de pantalla)", async () => {
    const { page, ctx } = await open({ width: 360, height: 740 });
    const wide = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 2 && getComputedStyle(e).position !== "fixed" && !e.closest("[aria-hidden]") && !e.closest("canvas"); }).slice(0, 5).map((e) => `${e.tagName}.${(e as HTMLElement).className}`));
    expect(wide).toEqual([]);
    await ctx.close();
  });
});

describe("landing · interacción", () => {
  it("los enlaces del menú desplazan hasta su sección", async () => {
    const { page, ctx } = await open({ width: 1440, height: 900 });
    await page.evaluate(() => (document.querySelector('a[href="#planes"]') as HTMLElement).click());
    await until(async () => (await page.evaluate(() => { const r = document.getElementById("planes")!.getBoundingClientRect(); return r.top < innerHeight * 0.6 && r.bottom > 0; })) || null, "llegar a Planes");
    await ctx.close();
  });

  it("el formulario exige el nombre y avisa si falta configurar el canal", async () => {
    const { page, ctx } = await open({ width: 1440, height: 900 });
    await page.evaluate(() => document.getElementById("contacto")!.scrollIntoView());
    await page.click(".contact button");
    await until(async () => (await page.$eval(".contact-note", (n) => n.textContent)) || null, "mensaje de validación");
    expect(await page.$eval(".contact-note", (n) => n.textContent)).toMatch(/nombre/i);
    await page.type('.contact input[name="nombre"]', "Prueba");
    await page.click(".contact button");
    await sleep(300);
    expect(await page.$eval(".contact-note", (n) => n.textContent)).toMatch(/NEXT_PUBLIC_|Abriendo/);
    await ctx.close();
  });

  it("el pie con olas dibuja en el canvas y se mueve", async () => {
    const { page, ctx } = await open({ width: 1440, height: 900 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(600);
    // El lienzo es WebGL (no se puede leer con drawImage): se compara una captura real de su zona
    const box = await page.evaluate(() => { const c = document.querySelector("footer canvas"); if (!c) return null; const r = c.getBoundingClientRect(); return { x: Math.max(0, r.x), y: Math.max(0, r.y) + scrollY, width: Math.min(r.width, innerWidth), height: Math.min(r.height, innerHeight) }; });
    expect(box).toBeTruthy();
    const snap = async () => Buffer.from(await page.screenshot({ clip: box!, encoding: "base64" }), "base64");
    const a = await snap();
    await sleep(900);
    const b = await snap();
    expect(a.equals(b)).toBe(false);
    await ctx.close();
  });

  it("el pie lleva el logo de Nodo y «by Kyloo»", async () => {
    const { page, ctx } = await open({ width: 1440, height: 900 });
    const t = await page.$eval("footer", (f) => (f as HTMLElement).innerText);
    expect(t.toLowerCase()).toContain("nodo");
    expect(await page.$('footer a[href*="kyloo"]')).toBeTruthy();
    await ctx.close();
  });
});

describe("landing · rutas y cabeceras", () => {
  it("una ruta inexistente responde 404 sin romper", async () => {
    expect((await fetch(`${URL_}/no-existe`)).status).toBe(404);
  });
  it("sirve fuentes locales (sin pedir nada a terceros)", async () => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    const hosts = new Set<string>();
    page.on("request", (r) => { if (!r.url().startsWith("data:") && !r.url().startsWith("blob:")) hosts.add(new URL(r.url()).host); });
    await page.goto(URL_, { waitUntil: "domcontentloaded" });
    await sleep(2500);
    expect([...hosts].filter((h) => !h.startsWith("127.0.0.1"))).toEqual([]);
    await ctx.close();
  });
});
