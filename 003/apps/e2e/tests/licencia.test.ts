import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../server/src/app";
import { openDb } from "../../server/src/db";
import { fingerprintOf } from "../../server/src/fingerprint";
import { Hub } from "../../server/src/hub";
import { generateSigningKeys } from "../../server/src/license";
import {
  type Browser,
  type Nodo,
  adminSession,
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
 * Activación de una instalación de producción con un código, a través de la pantalla:
 * restringida al principio (sin detener nada) y con el plan contratado después de canjear el código.
 */
let nodo: Nodo;
let hq: Awaited<ReturnType<typeof buildApp>>;
let hqUrl = "";
let browser: Browser;
let code = "";
const keys = generateSigningKeys();
const FP = fingerprintOf("equipo-de-la-prueba");

beforeAll(async () => {
  hq = buildApp(await openDb(":memory:"), {
    hub: new Hub(),
    hq: {
      adminToken: "plataforma",
      signingKey: keys.privateKey,
      backupStoreDir: mkdtempSync(join(tmpdir(), "nodo-hq-store-")),
    },
  });
  await hq.listen({ port: 0, host: "127.0.0.1" });
  const addr = hq.server.address();
  hqUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  const org = await hq.inject({
    method: "POST",
    url: "/api/hq/orgs",
    headers: { "x-hq-admin": "plataforma" },
    payload: {
      name: "Mariscos",
      plan: "profesional",
      owner: { username: "dueno", password: "clave-segura-1" },
    },
  });
  expect(org.statusCode).toBe(201);
  const token = (
    await hq.inject({
      method: "POST",
      url: "/api/hq/login",
      payload: { username: "dueno", password: "clave-segura-1" },
    })
  ).json().token as string;
  const br = await hq.inject({
    method: "POST",
    url: "/api/hq/branches",
    headers: { Authorization: `Bearer ${token}` },
    payload: { name: "Centro" },
  });
  code = br.json().activation_code;

  nodo = await startNodo({
    licensing: { mode: "enforced", publicKeys: [keys.publicKey], fingerprint: FP },
    hqUrl,
  });
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
  await nodo?.close();
  await hq?.close();
});

describe("activar con un código", () => {
  it("sin activar: avisa que rige el plan gratuito y muestra el identificador del equipo", async () => {
    const ctx = await newPage(browser, nodo.url);
    await adminSession(ctx.page, nodo.url);
    await tap(ctx.page, "Config", ".rail-btn");
    await tap(ctx.page, "Nube", ".view > .row.wrap > .chip");
    await settle(ctx.page);
    expect(await hasText(ctx.page, "todavía no está activado")).toBe(true);
    expect(await hasText(ctx.page, "Identificador de este equipo")).toBe(true);
    expect(await hasText(ctx.page, "Vinculación manual")).toBe(false); // en producción solo con código
    await ctx.ctx.close();
  });

  it("un código inválido muestra el error y no activa nada", async () => {
    const ctx = await newPage(browser, nodo.url);
    await adminSession(ctx.page, nodo.url);
    await tap(ctx.page, "Config", ".rail-btn");
    await tap(ctx.page, "Nube", ".view > .row.wrap > .chip");
    await tap(ctx.page, "Código de activación", "input");
    await ctx.page.keyboard.type("NODO-AAAA-BBBB-CCCC", { delay: 5 });
    await tap(ctx.page, "Activar este equipo", "button");
    await waitText(ctx.page, "Código inválido");
    expect(await hasText(ctx.page, "todavía no está activado")).toBe(true);
    await ctx.ctx.close();
  });

  it("el código correcto activa el equipo y aparece el plan contratado", async () => {
    const ctx = await newPage(browser, nodo.url);
    await adminSession(ctx.page, nodo.url);
    await tap(ctx.page, "Config", ".rail-btn");
    await tap(ctx.page, "Nube", ".view > .row.wrap > .chip");
    await tap(ctx.page, "Código de activación", "input");
    await ctx.page.keyboard.type(code, { delay: 5 });
    await tap(ctx.page, "Activar este equipo", "button");
    await until(
      async () => (await hasText(ctx.page, "profesional")) || null,
      "plan profesional",
      20_000,
    );
    expect(await hasText(ctx.page, "todavía no está activado")).toBe(false);
    const lic = (await nodo.db.prepare("SELECT value FROM settings WHERE key='license'").get()) as
      | { value: string }
      | undefined;
    expect(lic?.value).toBeTruthy();
    await ctx.ctx.close();
  });

  it("guarda la clave de recuperación y respalda en la nube desde la pantalla", async () => {
    const ctx = await newPage(browser, nodo.url);
    await adminSession(ctx.page, nodo.url);
    await tap(ctx.page, "Config", ".rail-btn");
    await tap(ctx.page, "Nube", ".view > .row.wrap > .chip");
    await waitText(ctx.page, "Respaldo en la nube");
    expect(await hasText(ctx.page, "falta guardar la clave de recuperación")).toBe(true);
    await tap(ctx.page, "Guardar clave de recuperación", "button");
    await waitText(ctx.page, "Escríbela en papel");
    const key = await ctx.page.evaluate(
      () => (document.querySelector(".sheet input") as HTMLInputElement).value,
    );
    expect(key).toMatch(/^([A-Z2-7]{5}-){10}[A-Z2-7]{5}$/);
    await tap(ctx.page, "Ya la guardé", "button");
    await until(
      async () => !(await hasText(ctx.page, "falta guardar la clave de recuperación")) || null,
      "clave confirmada",
    );
    await tap(ctx.page, "Respaldar ahora", "button");
    await until(async () => (await hasText(ctx.page, "último:")) || null, "respaldo hecho", 20_000);
    expect(ctx.problems.filter((x) => !/40[0-9]/.test(x))).toEqual([]);
    await ctx.ctx.close();
  });

  it("el mismo código no se puede usar otra vez", async () => {
    const r = await hq.inject({
      method: "POST",
      url: "/api/hq/activate",
      payload: { code, fingerprint: FP },
    });
    expect(r.statusCode).toBe(404);
  });
});
