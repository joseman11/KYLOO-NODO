import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Browser,
  type Nodo,
  type Page,
  adminSession,
  launch,
  newPage,
  sleep,
  startNodo,
  tap,
  until,
} from "./harness";

/**
 * Regla del producto: NINGUNA pantalla se desplaza. Todo cabe completo (se pagina) y nada queda cortado,
 * en tablets y pantallas táctiles de cualquier tamaño razonable.
 */
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

const VIEWPORTS = [
  { width: 1024, height: 600 },
  { width: 1280, height: 720 },
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 800, height: 1100 },
  { width: 768, height: 1024 },
];

interface Audit {
  pageScroll: boolean;
  mainOver: boolean;
  scrollers: string[];
  cut: string[];
}

/** Revisa que la pantalla actual no se desplace y que ningún botón quede cortado por su contenedor. */
const audit = (page: Page): Promise<Audit> =>
  page.evaluate(() => {
    const doc = document.documentElement;
    const pageScroll = doc.scrollHeight > innerHeight + 1 || doc.scrollWidth > innerWidth + 1;
    const main = document.querySelector(".main") as HTMLElement;
    const mainOver =
      main.scrollHeight > main.clientHeight + 2 || main.scrollWidth > main.clientWidth + 2;
    const scrollers = [...document.querySelectorAll(".main *")]
      .filter((e) => {
        const s = getComputedStyle(e);
        const sy = s.overflowY === "auto" || s.overflowY === "scroll";
        const sx = s.overflowX === "auto" || s.overflowX === "scroll";
        return (
          (sy && e.scrollHeight > e.clientHeight + 2) || (sx && e.scrollWidth > e.clientWidth + 2)
        );
      })
      .map(
        (e) => `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).slice(0, 40)}`,
      );
    // botones cortados: su caja sale del rectángulo visible de algún ancestro que recorta
    const cut: string[] = [];
    for (const b of document.querySelectorAll("button, input, select")) {
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      let clip = { l: 0, t: 0, r: innerWidth, b: innerHeight };
      for (let p = b.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.overflowX !== "visible" || s.overflowY !== "visible") {
          const pr = p.getBoundingClientRect();
          clip = {
            l: Math.max(clip.l, pr.left),
            t: Math.max(clip.t, pr.top),
            r: Math.min(clip.r, pr.right),
            b: Math.min(clip.b, pr.bottom),
          };
        }
      }
      if (
        r.right > clip.r + 2 ||
        r.left < clip.l - 2 ||
        r.bottom > clip.b + 2 ||
        r.top < clip.t - 2
      ) {
        cut.push(
          `${(b as HTMLElement).innerText?.trim().slice(0, 24) || (b as HTMLInputElement).placeholder || b.tagName}`,
        );
      }
    }
    return { pageScroll, mainOver, scrollers, cut };
  });

const railModules = (page: Page) =>
  page.$$eval(".rail-btn", (bs) =>
    bs.map((b) => (b as HTMLElement).innerText.replace(/[0-9]+$/, "").trim()),
  );
const expectClean = (a: Audit, where: string) => {
  expect(a.pageScroll, `${where}: la página se desplaza`).toBe(false);
  expect(a.mainOver, `${where}: el contenido se desborda`).toBe(false);
  expect(a.scrollers, `${where}: zonas con scroll`).toEqual([]);
  expect(a.cut, `${where}: controles cortados`).toEqual([]);
};

for (const vp of VIEWPORTS) {
  describe(`${vp.width}×${vp.height}`, () => {
    let page: Page;
    let close: () => Promise<void>;
    beforeAll(async () => {
      const n = await newPage(browser, nodo.url, vp);
      page = n.page;
      close = () => n.ctx.close();
      await adminSession(page, nodo.url);
    });
    afterAll(async () => {
      await close?.();
    });

    it("todos los módulos del menú caben sin desplazarse", async () => {
      const labels = await railModules(page);
      expect(labels.length).toBe(11); // incluye Recetas
      // con el menú colapsado (≤900 px) solo quedan los iconos: se toca por posición
      for (const [i, l] of labels.entries()) {
        const rects = await page.$$eval(".rail-btn", (bs) =>
          bs.map((b) => {
            const r = b.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }),
        );
        await page.mouse.click(rects[i]!.x, rects[i]!.y);
        await sleep(450);
        expectClean(await audit(page), `${vp.width}×${vp.height} · ${l || "módulo " + (i + 1)}`);
      }
    });

    it("las secciones de Configuración también caben", async () => {
      const rect = await page.$$eval(".rail-btn", (bs) => {
        const b = bs[bs.length - 1] as HTMLElement;
        const r = b.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await page.mouse.click(rect.x, rect.y);
      await sleep(400);
      const tabs = await page.$$eval(".view > .row.wrap > .chip", (cs) =>
        cs.map((c) => (c as HTMLElement).innerText.trim()),
      );
      expect(tabs.length).toBeGreaterThanOrEqual(11);
      for (const t of tabs) {
        await tap(page, t, ".view > .row.wrap > .chip");
        await sleep(400);
        expectClean(await audit(page), `${vp.width}×${vp.height} · Config › ${t}`);
      }
    });

    it("las ventanas de edición caben en pantalla", async () => {
      await tap(page, "Equipo", ".view > .row.wrap > .chip");
      await sleep(300);
      await tap(page, "+ Nuevo trabajador", "button");
      await until(async () => (await page.$(".sheet")) || null, "ventana de nuevo trabajador");
      const fits = await page.$eval(".sheet", (s) => ({
        over: s.scrollHeight > s.clientHeight + 2,
        h: s.getBoundingClientRect().height,
        win: innerHeight,
      }));
      expect(fits.over, "la ventana de nuevo trabajador tiene scroll").toBe(false);
      expect(fits.h).toBeLessThanOrEqual(fits.win);
      await tap(page, "Cancelar", ".sheet button");
      await sleep(250);
    });
  });
}
