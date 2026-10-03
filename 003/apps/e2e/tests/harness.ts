/**
 * Arnés de pruebas de interfaz: levanta Nodo REAL (servidor + app compilada + datos de la demo de mariscos)
 * en un puerto libre y lo maneja con Chrome. Cada archivo de pruebas obtiene su propia base limpia.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../server/src/app";
import { openDb, type Db } from "../../server/src/db";
import { seedDemo } from "../../server/src/seed-demo";
import { Hub } from "../../server/src/hub";
import type { PrinterTarget, PrinterTransport } from "../../server/src/printing/transport";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const WEB_DIST = resolve(HERE, "../../web/dist");

export const CHROME =
  process.env.CHROME_PATH ??
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((p) => existsSync(p));

export class FakeTransport implements PrinterTransport {
  sent: { host: string | null; text: string }[] = [];
  async send(t: PrinterTarget, data: Buffer) {
    this.sent.push({ host: t.host, text: data.toString("latin1") });
  }
  async ping() {
    return true;
  }
}

export interface Nodo {
  url: string;
  db: Db;
  app: FastifyInstance;
  hub: Hub;
  transport: FakeTransport;
  close: () => Promise<void>;
}

export async function startNodo(): Promise<Nodo> {
  if (!existsSync(join(WEB_DIST, "index.html")))
    throw new Error("Falta compilar la app: pnpm --filter @003/web build");
  const db = await openDb(":memory:");
  const photosDir = mkdtempSync(join(tmpdir(), "nodo-e2e-"));
  await seedDemo(db, { photosDir });
  const hub = new Hub();
  const transport = new FakeTransport();
  const app = buildApp(db, { webDir: WEB_DIST, photosDir, hub, transport });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    db,
    app,
    hub,
    transport,
    close: async () => {
      await app.close();
      rmSync(photosDir, { recursive: true, force: true });
    },
  };
}

export async function launch(): Promise<Browser> {
  if (!CHROME) throw new Error("No se encontró Chrome/Edge: define CHROME_PATH");
  return puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      "--no-sandbox",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ],
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Espera hasta que la condición sea verdadera (revisando cada 100 ms). */
export async function until<T>(
  fn: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  what = "condición",
  timeout = 12_000,
): Promise<T> {
  const t0 = Date.now();
  let last: unknown;
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await sleep(100);
  }
  throw new Error(
    `Tiempo agotado esperando: ${what}${last ? ` (${(last as Error).message})` : ""}`,
  );
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Rectángulo del primer elemento visible cuyo texto empieza con `text`. */
export const rectOf = (
  page: Page,
  text: string,
  sel = "button, label, a, .rail-btn, .table-card, .product, input, .tk, .opt, .chip",
  mode: "start" | "include" = "start",
) =>
  page.evaluate(
    (text, sel, mode) => {
      const el = [...document.querySelectorAll(sel)].find((e) => {
        const r = e.getBoundingClientRect();
        const t = (
          (e as HTMLElement).innerText ||
          (e as HTMLInputElement).placeholder ||
          ""
        ).trim();
        return (
          r.width > 0 &&
          r.height > 0 &&
          (mode === "include" ? t.includes(text) : t.startsWith(text))
        );
      });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height } as Rect;
    },
    text,
    sel,
    mode,
  );

/** Toca (clic real con el mouse) el elemento por su texto. */
export async function tap(
  page: Page,
  text: string,
  sel?: string,
  timeout = 12_000,
  mode: "start" | "include" = "start",
) {
  const r = await until(() => rectOf(page, text, sel, mode), `elemento «${text}»`, timeout);
  await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2);
  await sleep(120);
  return r;
}

/**
 * Selecciona todo el texto del campo enfocado. No se usa el atajo de teclado: en macOS Ctrl+A solo mueve el cursor
 * y Cmd+A no lo dispara Puppeteer sin comandos nativos, así que lo escrito después se anexaba («1035.002000»).
 */
export async function selectAll(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.select?.());
}

/** Espera a que la pantalla deje de cambiar (texto idéntico en tres lecturas seguidas); útil con equipos lentos. */
export async function settle(page: Page, timeout = 12_000) {
  let prev = "",
    same = 0;
  await until(
    async () => {
      const now = await bodyText(page);
      same = now === prev ? same + 1 : 0;
      prev = now;
      await sleep(150);
      return same >= 3 || null;
    },
    "que la pantalla se estabilice",
    timeout,
  );
}

export const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);
export const hasText = async (page: Page, text: string) => (await bodyText(page)).includes(text);
export const waitText = (page: Page, text: string, timeout = 12_000) =>
  until(async () => (await hasText(page, text)) || null, `texto «${text}»`, timeout);
export const waitGone = (page: Page, text: string, timeout = 12_000) =>
  until(async () => !(await hasText(page, text)) || null, `que desaparezca «${text}»`, timeout);

export async function newPage(browser: Browser, url: string, size = { width: 1280, height: 800 }) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ ...size, deviceScaleFactor: 1 });
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${(e as Error).message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text()))
      problems.push(`console: ${m.text()}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !/favicon|api\/cash\/current/.test(r.url()))
      problems.push(`http ${r.status()}: ${new URL(r.url()).pathname + new URL(r.url()).search}`);
  });
  page.on("requestfailed", (r) => {
    if (!/websocket|\/ws\?|favicon/i.test(r.url())) problems.push(`requestfailed: ${r.url()}`);
  });
  await page.goto(url, { waitUntil: "networkidle0" });
  return { page, ctx, problems };
}

/** Inicia sesión con PIN usando el teclado de la pantalla (clics reales). */
export async function loginWithPin(page: Page, name: string, pin: string) {
  await until(async () => (await hasText(page, "Toca tu nombre")) || null, "pantalla de acceso");
  await tap(page, name, ".user-card", 12_000, "include");
  await until(async () => (await rectOf(page, "Entrar", ".pad button")) || null, "teclado de PIN");
  for (const d of pin) await tap(page, d, ".pad button");
  await tap(page, "Entrar", ".pad button");
}

/** Sesión directa por API (para pruebas que no son del acceso). */
export async function sessionFor(page: Page, url: string, name: string, pin: string) {
  await page.evaluate(
    async (name, pin) => {
      const users = await fetch("/api/auth/users").then((r) => r.json());
      const u = users.find((x: { name: string }) => x.name === name);
      const r = await fetch("/api/auth/pin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: u.id, pin }),
      }).then((r) => r.json());
      localStorage.setItem("003.session", JSON.stringify({ token: r.token, user: r.user }));
    },
    name,
    pin,
  );
  await page.goto(url, { waitUntil: "networkidle0" });
  await until(async () => !(await hasText(page, "Toca tu nombre")) || null, "sesión iniciada");
}

export async function adminSession(page: Page, url: string) {
  await page.evaluate(async () => {
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin1234" }),
    }).then((r) => r.json());
    localStorage.setItem("003.session", JSON.stringify({ token: r.token, user: r.user }));
  });
  await page.goto(url, { waitUntil: "networkidle0" });
  await until(
    async () => !(await hasText(page, "Toca tu nombre")) || null,
    "sesión de administración",
  );
}

export const apiToken = async (nodo: Nodo, name?: string, pin?: string) => {
  if (!name)
    return (
      await nodo.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: "admin1234" },
      })
    ).json().token as string;
  const users = (await nodo.app.inject({ method: "GET", url: "/api/auth/users" })).json() as {
    id: string;
    name: string;
  }[];
  const u = users.find((x) => x.name === name)!;
  return (
    await nodo.app.inject({ method: "POST", url: "/api/auth/pin", payload: { userId: u.id, pin } })
  ).json().token as string;
};
export const api = async (
  nodo: Nodo,
  token: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
) => {
  const r = await nodo.app.inject({
    method,
    url,
    headers: { Authorization: `Bearer ${token}` },
    payload: payload as object,
  });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};

export type { Page, Browser };

/** ¿Aparece el texto en alguna página del paginador de la pantalla actual? (recorre las páginas con «›»). */
export async function pagedHasText(page: Page, text: string, maxPages = 12): Promise<boolean> {
  await settle(page);
  for (let i = 0; i < maxPages; i++) {
    if (await hasText(page, text)) return true;
    const next = await rectOf(page, "›", ".view .pager button, .sheet .pager button");
    if (!next) return false;
    const disabled = await page.evaluate(
      (x, y) => (document.elementFromPoint(x, y) as HTMLButtonElement | null)?.disabled ?? false,
      next.x + next.w / 2,
      next.y + next.h / 2,
    );
    if (disabled) return false;
    await page.mouse.click(next.x + next.w / 2, next.y + next.h / 2);
    await sleep(250);
  }
  return false;
}

/** Vuelve a la primera página del paginador (si hay). */
export async function firstPage(page: Page) {
  for (let i = 0; i < 12; i++) {
    const prev = await rectOf(page, "‹", ".view .pager button, .sheet .pager button");
    if (!prev) return;
    const disabled = await page.evaluate(
      (x, y) => (document.elementFromPoint(x, y) as HTMLButtonElement | null)?.disabled ?? true,
      prev.x + prev.w / 2,
      prev.y + prev.h / 2,
    );
    if (disabled) return;
    await page.mouse.click(prev.x + prev.w / 2, prev.y + prev.h / 2);
    await sleep(200);
  }
}

/** Toca el botón `button` de la fila de tabla que contiene `rowText`, buscando en todas las páginas. */
export async function rowButton(page: Page, rowText: string, button: string, timeout = 15_000) {
  await firstPage(page);
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const r = await page.evaluate(
      (rowText, button) => {
        const tr = [...document.querySelectorAll("tr")].find((x) =>
          (x as HTMLElement).innerText.includes(rowText),
        );
        const b =
          tr &&
          [...tr.querySelectorAll("button")].find(
            (x) => (x as HTMLElement).innerText.trim() === button,
          );
        if (!b) return null;
        const rc = b.getBoundingClientRect();
        return { x: rc.x + rc.width / 2, y: rc.y + rc.height / 2 };
      },
      rowText,
      button,
    );
    if (r) {
      await page.mouse.click(r.x, r.y);
      await sleep(150);
      return;
    }
    const next = await rectOf(page, "›", ".view .pager button, .sheet .pager button");
    if (!next) break;
    await page.mouse.click(next.x + next.w / 2, next.y + next.h / 2);
    await sleep(250);
  }
  throw new Error(`No se encontró «${button}» en la fila «${rowText}»`);
}
