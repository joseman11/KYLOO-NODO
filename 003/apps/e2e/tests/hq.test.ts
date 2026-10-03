import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../server/src/app";
import { openDb } from "../../server/src/db";
import { fingerprintOf } from "../../server/src/fingerprint";
import { Hub } from "../../server/src/hub";
import { generateSigningKeys } from "../../server/src/license";
import {
  type Browser,
  WEB_DIST,
  hasText,
  launch,
  newPage,
  settle,
  tap,
  until,
  waitText,
} from "./harness";

/** Consola del HQ (nube): el propietario crea una sucursal, emite códigos de activación y ve el estado de su equipo. */
let hq: ReturnType<typeof buildApp>;
let url = "";
let browser: Browser;
const keys = generateSigningKeys();

beforeAll(async () => {
  hq = buildApp(await openDb(":memory:"), {
    hub: new Hub(),
    webDir: WEB_DIST,
    hq: { adminToken: "plataforma", signingKey: keys.privateKey },
  });
  await hq.listen({ port: 0, host: "127.0.0.1" });
  const a = hq.server.address();
  url = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  await hq.inject({
    method: "POST",
    url: "/api/hq/orgs",
    headers: { "x-hq-admin": "plataforma" },
    payload: {
      name: "Mariscos",
      plan: "profesional",
      owner: { username: "dueno", password: "clave-segura-1" },
    },
  });
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
  await hq?.close();
});

const sheetCode = (page: Awaited<ReturnType<typeof newPage>>["page"]) =>
  page.evaluate(
    () => (document.querySelector(".sheet input") as HTMLInputElement | null)?.value ?? "",
  );

describe("consola del HQ", () => {
  it("crea una sucursal y muestra su código de activación; después permite emitir uno nuevo", async () => {
    const ctx = await newPage(browser, `${url}/hq`);
    const p = ctx.page;
    await tap(p, "Usuario", "input");
    await p.keyboard.type("dueno", { delay: 5 });
    await tap(p, "Contraseña", "input");
    await p.keyboard.type("clave-segura-1", { delay: 5 });
    await tap(p, "Entrar", "button");
    await until(async () => (await hasText(p, "Sucursales")) || null, "consola abierta", 20_000);
    await tap(p, "Sucursales", ".chip");
    await settle(p);

    await tap(p, "Nombre", "input");
    await p.keyboard.type("Centro", { delay: 5 });
    await tap(p, "Crear sucursal", "button");
    await waitText(p, "Código de activación de Centro");
    const first = await sheetCode(p);
    expect(first).toMatch(/^NODO-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    // la llave de la sucursal ya no se muestra
    expect(await hasText(p, "bk_")).toBe(false);
    await tap(p, "Listo", "button");

    await until(async () => (await hasText(p, "sin activar")) || null, "sucursal sin activar");
    expect(await hasText(p, "ninguno")).toBe(true); // sin respaldos todavía

    await tap(p, "Código nuevo", "button");
    await waitText(p, "Código de activación de Centro");
    const second = await sheetCode(p);
    expect(second).toMatch(/^NODO-/);
    expect(second).not.toBe(first); // el nuevo anula al anterior
    await tap(p, "Listo", "button");

    // el equipo canjea el código nuevo y la consola muestra su identificador corto
    const r = await hq.inject({
      method: "POST",
      url: "/api/hq/activate",
      payload: { code: second, fingerprint: fingerprintOf("equipo-del-local") },
    });
    expect(r.statusCode).toBe(200);
    await p.reload({ waitUntil: "networkidle0" });
    await tap(p, "Sucursales", ".chip");
    await until(async () => !(await hasText(p, "sin activar")) || null, "equipo activado");
    expect(ctx.problems.filter((x) => !/401/.test(x))).toEqual([]);
    await ctx.ctx.close();
  });
});
