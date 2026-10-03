import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Browser,
  type Nodo,
  type Page,
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
 * Primer arranque de una instalación nueva: sin usuarios ni claves de fábrica, un asistente crea
 * al administrador y el local queda listo para configurarse.
 */
let nodo: Nodo;
let browser: Browser;
beforeAll(async () => {
  nodo = await startNodo({ demo: false });
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
  await nodo?.close();
});

const fill = async (page: Page, placeholder: string, value: string) => {
  await tap(page, placeholder, "input");
  await page.keyboard.type(value, { delay: 5 });
};

describe("primer arranque", () => {
  let ctx: Awaited<ReturnType<typeof newPage>>;

  it("una instalación nueva muestra el asistente y ninguna lista de usuarios", async () => {
    ctx = await newPage(browser, nodo.url);
    await waitText(ctx.page, "Bienvenido a Nodo");
    expect(await hasText(ctx.page, "Toca tu nombre")).toBe(false);
    expect(await hasText(ctx.page, "Crear y entrar")).toBe(true);
  });

  it("rechaza contraseñas que no coinciden sin crear nada", async () => {
    const p = ctx.page;
    await fill(p, "Nombre del local", "Mariscos El Faro");
    await fill(p, "Tu nombre", "Ana Pérez");
    await fill(p, "Usuario de administrador", "ana");
    await fill(p, "Contraseña", "una-clave-larga-1");
    await fill(p, "Repite la contraseña", "otra-distinta-22");
    await tap(p, "Crear y entrar", "button");
    await waitText(p, "Las contraseñas no coinciden");
    const users = (await nodo.db.prepare("SELECT COUNT(*) c FROM users").get()) as { c: number };
    expect(users.c).toBe(0);
  });

  it("crea al administrador y entra a la aplicación", async () => {
    const p = ctx.page;
    // corrige la repetición: selecciona el campo y escribe la correcta
    await tap(p, "Repite la contraseña", "input");
    await p.evaluate(() => (document.activeElement as HTMLInputElement).select());
    await p.keyboard.type("una-clave-larga-1", { delay: 5 });
    await tap(p, "Crear y entrar", "button");
    await until(
      async () => !(await hasText(p, "Bienvenido a Nodo")) || null,
      "salir del asistente",
      20_000,
    );
    await settle(p);
    expect(await hasText(p, "Ana Pérez")).toBe(true);
    const u = (await nodo.db.prepare("SELECT username, role FROM users").get()) as {
      username: string;
      role: string;
    };
    expect(u).toMatchObject({ username: "ana", role: "admin" });
    const name = (await nodo.db
      .prepare("SELECT value FROM settings WHERE key='establishment_name'")
      .get()) as { value: string };
    expect(name.value).toBe("Mariscos El Faro");
  });

  it("después de configurar, el asistente no vuelve: se ve el acceso normal", async () => {
    const fresh = await newPage(browser, nodo.url);
    await until(
      async () => (await hasText(fresh.page, "Administración")) || null,
      "pantalla de acceso",
    );
    expect(await hasText(fresh.page, "Bienvenido a Nodo")).toBe(false);
    expect(await hasText(fresh.page, "Mariscos El Faro")).toBe(true);
    // y la ruta de configuración ya está cerrada
    const r = await fresh.page.evaluate(async () => {
      const x = await fetch("/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          establishment: "x",
          adminName: "intruso",
          username: "intruso",
          password: "otra-clave-larga-3",
        }),
      });
      return x.status;
    });
    expect(r).toBe(409);
    await fresh.ctx.close();
  });

  it("sin errores de consola ni respuestas fallidas inesperadas", () => {
    // 4xx de la validación del asistente son esperados (contraseñas distintas no llegan al servidor)
    expect(ctx.problems.filter((x) => !/409/.test(x))).toEqual([]);
  });
});
