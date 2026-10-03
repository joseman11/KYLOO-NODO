/**
 * Captura el DOM REAL de la app (Nodo) en cada paso de tres historias, junto con el rectángulo del
 * elemento que se toca después. Con eso las películas HTML (film/) pueden animar el cursor, los toques y
 * la cámara sobre la interfaz verdadera, y renderizarla a .mp4 cuadro por cuadro.
 *
 * Requisitos: la demo corriendo en BASE (puerto 3006, recién sembrada con reset.ps1) y la app compilada.
 */
import puppeteer from "puppeteer-core";
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE ?? "http://localhost:3006";
import { APP_DIST, PHOTOS, ROOT, chromePath } from "./paths.mjs";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Recursos de la app para las películas (CSS compilado, tipografías y fotos de platillos)
rmSync(join(ROOT, "film/app"), { recursive: true, force: true });
mkdirSync(join(ROOT, "film/app/photos"), { recursive: true });
cpSync(APP_DIST, join(ROOT, "film/app/assets"), { recursive: true });
cpSync(PHOTOS, join(ROOT, "film/app/photos"), { recursive: true });
const css = readdirSync(APP_DIST).find((f) => f.endsWith(".css"));
// la app se sirve desde la raíz (/assets/...); aquí las tipografías se resuelven junto al CSS
{
  const p = join(ROOT, "film/app/assets", css);
  writeFileSync(p, readFileSync(p, "utf8").replaceAll("url(/assets/", "url(./"));
}

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: "new",
});
const VIEW = { width: 1280, height: 800, deviceScaleFactor: 1 };

async function role(name, pin, user = null) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(VIEW);
  await page.goto(BASE, { waitUntil: "networkidle0" });
  await page.evaluate(
    async (name, pin) => {
      const users = await fetch("/api/auth/users").then((r) => r.json());
      const u = users.find((x) => x.name === name);
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
  await page.goto(BASE, { waitUntil: "networkidle0" });
  await wait(1200);
  return page;
}

const STATES = {};
const find = (page, text, sel = "button, label, .rail-btn, a, .table-card, .product, input") =>
  page.evaluate(
    (text, sel) => {
      const els = [...document.querySelectorAll(sel)];
      const el = els.find((e) => {
        const r = e.getBoundingClientRect();
        const t = (e.textContent || e.placeholder || "").trim();
        return r.width > 0 && t.startsWith(text);
      });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    },
    text,
    sel,
  );

/** Guarda el DOM actual con el rectángulo del siguiente toque. */
async function snap(page, name, target = null) {
  const html = await page.evaluate(() => {
    // los valores escritos viven en propiedades, no en atributos: se copian para que sobrevivan al outerHTML
    document.querySelectorAll("input").forEach((i) => i.setAttribute("value", i.value));
    document.querySelectorAll("select").forEach((s) => {
      [...s.options].forEach((o) => o.toggleAttribute("selected", o.selected));
    });
    return document.getElementById("root").innerHTML;
  });
  STATES[name] = { html: html.replaceAll("/api/photos/", "app/photos/"), target };
  return STATES[name];
}
async function tap(page, name, text, sel, after = 750) {
  let t = await find(page, text, sel);
  // si el elemento está en otra página del paginador, avanza
  for (let i = 0; i < 3 && !t; i++) {
    const next = await find(page, "›", ".pager button");
    if (!next) break;
    await page.mouse.click(next.x + next.w / 2, next.y + next.h / 2);
    await wait(500);
    t = await find(page, text, sel);
  }
  if (!t) throw new Error(`no encontrado: ${text} (${name})`);
  await snap(page, name, t);
  await page.mouse.click(t.x + t.w / 2, t.y + t.h / 2);
  await wait(after);
  return t;
}

// ───────── Cocina (Cevichería) espera, antes de que llegue el pedido ─────────
const chef = await role("Chef Ramón", "7777");
await (async () => {
  const t = await find(chef, "Cocina", ".rail-btn");
  await chef.mouse.click(t.x + t.w / 2, t.y + t.h / 2);
  await wait(800);
})();
await tap(chef, "kds_choose", "Cevichería", "button", 1800);
await snap(chef, "kds_before");

// ───────── Caja (cobro) ─────────
const caja = await role("Caja", "3333");

// ───────── Mesero: el pedido ─────────
const w = await role("Juan", "1111");
await tap(w, "w_map", "T3", ".table-card");
await tap(w, "w_t3", "Abrir mesa", "button");
await tap(w, "w_order0", "Entradas", "button");
await tap(w, "w_cat", "Ceviche mixto", ".product", 900);
await tap(w, "w_mod1a", "Aguacate", "button", 400);
await tap(w, "w_mod1b", "Poco picante", "button", 400);
await tap(w, "w_mod1c", "Agregar", "button");
await tap(w, "w_order1", "Aguachile verde", ".product", 900);
await tap(w, "w_mod2a", "Normal", "button", 400);
await tap(w, "w_mod2b", "Agregar", "button");
await tap(w, "w_order2", "Buscar", "input", 300);
await w.keyboard.type("Michel", { delay: 40 });
await wait(500);
await tap(w, "w_search", "Michelada", ".product");
await tap(w, "w_order3", "Enviar comanda", "button", 1500);
await snap(w, "w_sent");

// la cocina recibe el pedido en vivo (WebSocket)
await wait(800);
await tap(chef, "kds_arrive", "Preparar", "button");
await tap(chef, "kds_prep", "Listo", "button", 900);
await snap(chef, "kds_ready");

// el mesero ve "Listos para entregar" y entrega
await tap(w, "w_back", "← Mesas", "button", 900);
const rowT = await w.evaluate(() => {
  const row = [...document.querySelectorAll("aside.pane tr")].find((r) =>
    r.textContent.trim().startsWith("T3"),
  );
  const b =
    row && [...row.querySelectorAll("button")].find((x) => x.textContent.trim() === "Entregar");
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
});
if (!rowT) throw new Error("T3 no aparece en listos");
await snap(w, "w_ready", rowT);
await w.mouse.click(rowT.x + rowT.w / 2, rowT.y + rowT.h / 2);
await wait(900);
await snap(w, "w_delivered");

// ───────── Cobro ─────────
await tap(caja, "c_map", "T4", ".table-card");
await tap(caja, "c_t4", "Cobrar", "button", 1000);
await tap(caja, "c_sheet", "Partes iguales", ".sheet button");
await tap(caja, "c_split", "Cuenta completa", ".sheet button");
const monto = await caja.evaluate(() => {
  const r = document.querySelector(".sheet input[placeholder=Monto]").getBoundingClientRect();
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
});
await snap(caja, "c_full", monto);
await caja.mouse.click(monto.x + monto.w / 2, monto.y + monto.h / 2);
await caja.keyboard.down("Control");
await caja.keyboard.press("KeyA");
await caja.keyboard.up("Control");
await caja.keyboard.type("1100", { delay: 40 });
await wait(500);
const pay = await find(caja, "Cobrar $", ".sheet button");
await snap(caja, "c_typed", pay);
await caja.mouse.click(pay.x + pay.w / 2, pay.y + pay.h / 2);
await wait(1500);
await snap(caja, "c_done");

writeFileSync(
  join(ROOT, "film/states.js"),
  `/* DOM real de la app en cada paso (generado por capture-states.mjs) */\nwindow.APP_CSS = ${JSON.stringify("app/assets/" + css)};\nwindow.STATES = ${JSON.stringify(STATES)};\n`,
);
console.log("estados:", Object.keys(STATES).length, Object.keys(STATES).join(", "));
await browser.close();
