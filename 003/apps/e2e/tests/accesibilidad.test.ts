import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Browser,
  type Nodo,
  type Page,
  adminSession,
  hasText,
  launch,
  newPage,
  sessionFor,
  settle,
  startNodo,
  tap,
  until,
} from "./harness";

/**
 * Accesibilidad medible (plan 08): `axe-core` revisa cada pantalla clave contra WCAG 2.1 AA (contraste, nombres de
 * botones, etiquetas de campos, estructura). Un hallazgo serio o crítico rompe la prueba.
 */
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

let nodo: Nodo;
let browser: Browser;
beforeAll(async () => {
  nodo = await startNodo();
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
  await nodo?.close();
});

interface Finding {
  id: string;
  impact: string;
  nodes: { target: string[]; summary: string }[];
}

async function audit(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  const found = await page.evaluate(async () => {
    // @ts-expect-error axe se inyecta arriba
    const r = await axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"] },
      // Reglas de página completa que no aplican a una app de una sola pantalla
      rules: {
        region: { enabled: false },
        "landmark-one-main": { enabled: false },
        "page-has-heading-one": { enabled: false },
      },
    });
    return r.violations
      .filter((v: { impact: string }) => v.impact === "serious" || v.impact === "critical")
      .map(
        (v: {
          id: string;
          impact: string;
          nodes: { target: string[]; failureSummary: string }[];
        }) => ({
          id: v.id,
          impact: v.impact,
          nodes: v.nodes
            .slice(0, 4)
            .map((n) => ({ target: n.target, summary: n.failureSummary.split("\n")[1] ?? "" })),
        }),
      );
  });
  return (found as Finding[]).map(
    (f) =>
      `${f.id} (${f.impact}): ${f.nodes.map((n) => `${n.target.join(" ")} → ${n.summary.trim()}`).join(" | ")}`,
  );
}

describe("accesibilidad (WCAG 2.1 AA)", () => {
  it("el acceso (elegir nombre y teclado de PIN)", async () => {
    const { page, ctx } = await newPage(browser, nodo.url);
    await until(async () => (await hasText(page, "Toca tu nombre")) || null, "acceso");
    expect(await audit(page), "acceso").toEqual([]);
    await ctx.close();
  });

  const screens: { who: [string, string] | "admin"; tab: string; name: string }[] = [
    { who: ["Juan", "1111"], tab: "Mesas", name: "mapa de mesas" },
    { who: ["Juan", "1111"], tab: "Pase", name: "pase" },
    { who: ["Caja", "3333"], tab: "Caja", name: "caja" },
    { who: ["Chef Ramón", "7777"], tab: "Cocina", name: "cocina" },
    { who: "admin", tab: "Inventario", name: "inventario" },
    { who: "admin", tab: "Config", name: "configuración" },
    { who: "admin", tab: "Admin", name: "administración" },
  ];
  for (const s of screens) {
    it(s.name, async () => {
      const { page, ctx } = await newPage(browser, nodo.url);
      if (s.who === "admin") await adminSession(page, nodo.url);
      else await sessionFor(page, nodo.url, s.who[0], s.who[1]);
      await tap(page, s.tab, ".rail-btn");
      await settle(page);
      expect(await audit(page), s.name).toEqual([]);
      await ctx.close();
    });
  }

  it("la cuenta de una mesa (comandero)", async () => {
    const { page, ctx } = await newPage(browser, nodo.url);
    await sessionFor(page, nodo.url, "Juan", "1111");
    await settle(page);
    await page.evaluate(() =>
      (document.querySelector(".table-card.disponible") as HTMLElement).click(),
    );
    await until(async () => (await hasText(page, "Abrir mesa")) || null, "panel de la mesa");
    await tap(page, "Abrir mesa", "button");
    await until(async () => (await hasText(page, "Enviar comanda")) || null, "comandero");
    await settle(page);
    expect(await audit(page), "comandero").toEqual([]);
    await ctx.close();
  });
});
