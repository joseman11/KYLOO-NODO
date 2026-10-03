import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../server/src/app";
import { openDb } from "../../server/src/db";
import { Hub } from "../../server/src/hub";
import { seed } from "../../server/src/seed";
import { readStandby } from "../../server/src/standby";
import { startStandby } from "../../server/src/standby-app";
import { decide, probeServers } from "../../web/src/failover";
import { type Browser, hasText, launch, newPage, until } from "./harness";

/** Servidor de reserva: la página de la reserva en un navegador real y la decisión de cambio de servidor de las tablets. */
describe("cambio de servidor en la tablet", () => {
  const reply = async (role: string | null) => {
    if (!role) throw new Error("sin respuesta");
    return new Response(JSON.stringify({ ok: true, role }), { status: 200 });
  };

  it("se pasa al servidor que ya es principal y avisa de una reserva sin promover", async () => {
    const f = ((url: string) =>
      reply(
        url.startsWith("http://a") ? null : url.startsWith("http://b") ? "standby" : "primary",
      )) as never;
    const probes = await probeServers(["http://a:3003", "http://b:3003", "http://c:3003"], f);
    expect(probes.map((p) => p.role)).toEqual([null, "standby", "primary"]);
    expect(decide(probes)).toEqual({ go: "http://c:3003", standby: "http://b:3003" });
    expect(decide(probes.slice(0, 2))).toEqual({ go: null, standby: "http://b:3003" });
    expect(decide([{ url: "x", role: null }])).toEqual({ go: null, standby: null });
  });

  it("un servidor que contesta basura o falla no cuenta", async () => {
    const f = (async () => new Response("<html>", { status: 200 })) as never;
    expect((await probeServers(["http://x:3003"], f))[0]?.role).toBeNull();
    const g = (async () => new Response("{}", { status: 500 })) as never;
    expect((await probeServers(["http://x:3003"], g))[0]?.role).toBeNull();
  });
});

describe("página de la reserva", () => {
  let tmp: string;
  let browser: Browser;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nodo-reserva-e2e-"));
    browser = await launch();
  });
  afterAll(async () => {
    await browser?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("muestra el estado de la copia y promueve a principal con la clave", async () => {
    // principal de verdad, por HTTP
    const db = await openDb(join(tmp, "principal.sqlite"));
    await seed(db, "clave-del-local-1");
    const photos = join(tmp, "fotos");
    mkdirSync(photos, { recursive: true });
    const primary = buildApp(db, {
      hub: new Hub(),
      photosDir: photos,
      backupDir: join(tmp, "resp"),
    });
    await primary.listen({ port: 0, host: "127.0.0.1" });
    const pa = primary.server.address();
    const primaryUrl = `http://127.0.0.1:${typeof pa === "object" && pa ? pa.port : 0}`;
    const login = (
      await primary.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: "clave-del-local-1" },
      })
    ).json().token as string;
    const key = (
      await primary.inject({
        method: "POST",
        url: "/api/standby/pairing",
        headers: { Authorization: `Bearer ${login}` },
        payload: { password: "clave-del-local-1" },
      })
    ).json().key as string;

    const dataDir = join(tmp, "reserva-datos");
    const s = await startStandby({
      dataDir,
      dbFile: join(dataDir, "nodo.sqlite"),
      photosDir: join(dataDir, "photos"),
      dir: join(dataDir, "reserva"),
      state: { primary: primaryUrl, key },
      port: -1,
      host: "127.0.0.1",
      version: "e2e",
      intervalMs: 0,
    });
    await s.app.listen({ port: 0, host: "127.0.0.1" });
    const sa = s.app.server.address();
    const standbyUrl = `http://127.0.0.1:${typeof sa === "object" && sa ? sa.port : 0}`;
    await s.tick();

    const { page } = await newPage(browser, standbyUrl);
    await until(async () => (await hasText(page, "responde")) || null, "estado del principal");
    expect(await hasText(page, "sin respuesta")).toBe(false);

    // el principal se cae
    await primary.close();
    await until(
      async () => (await hasText(page, "sin respuesta")) || null,
      "principal caído",
      20_000,
    );

    await page.type("#k", "clave-que-no-es");
    await page.click("#go");
    await until(async () => (await hasText(page, "no coincide")) || null, "clave rechazada");

    await page.$eval("#k", (el) => ((el as HTMLInputElement).value = ""));
    await page.type("#k", key);
    await page.click("#go");
    await until(
      async () => (await hasText(page, "ya es el servidor principal")) || null,
      "promovida",
    );
    await s.promoted;
    expect(readStandby(dataDir)?.promoted).toBe(true);
    await s.stop();
    await db.close();
  });
});
