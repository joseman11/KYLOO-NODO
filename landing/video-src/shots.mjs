// Capturas fijas de pantallas de Nodo para la landing (demo en BASE, puerto 3006).
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { chromePath } from "./paths.mjs";
const BASE = process.env.BASE ?? "http://localhost:3006";
const OUT = fileURLToPath(new URL("../public/shots/", import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: chromePath(), headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 0.75 });
await page.goto(BASE);
await page.evaluate(async () => {
  const r = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin1234" }),
  }).then((r) => r.json());
  localStorage.setItem("003.session", JSON.stringify({ token: r.token, user: r.user }));
});
await page.goto(BASE, { waitUntil: "networkidle0" });
const click = (sel, text) =>
  page.evaluate(
    (sel, text) => {
      const b = [...document.querySelectorAll(sel)].find((x) =>
        (x.textContent ?? "")
          .replace(/[0-9]+$/, "")
          .trim()
          .startsWith(text),
      );
      b?.click();
      return !!b;
    },
    sel,
    text,
  );
const shot = async (name) => {
  await wait(700);
  await page.screenshot({ path: OUT + name + ".jpg", type: "jpeg", quality: 82 });
  console.log(name);
};
await click(".rail-btn", "Inventario");
await click(".chip", "Existencias");
await click(".chip", "Cocina");
await shot("inventario");
await click(".chip", "Listas de compras");
await shot("listas");
await click(".rail-btn", "Recetas");
await shot("recetas");
await browser.close();
