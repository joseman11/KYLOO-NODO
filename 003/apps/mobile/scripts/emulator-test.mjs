/**
 * Prueba de la app en un emulador o tablet real conectada por adb (no forma parte de CI: necesita el dispositivo).
 *
 *   adb install -r dist/nodo-<v>-debug.apk && adb shell am start -n mx.com.kyloo.nodo/.MainActivity
 *   adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof mx.com.kyloo.nodo)
 *   NODO_SERVER=10.0.2.2:3005 node scripts/emulator-test.mjs
 *
 * (10.0.2.2 es la PC anfitriona vista desde el emulador; en una tablet real, la IP del servidor.) Maneja el WebView de la app
 * con el depurador remoto de Chrome: primera conexión, acceso por PIN, trabajo contra el servidor y reapertura sin red.
 */
import puppeteer from "puppeteer-core";
import assert from "node:assert/strict";

const server = process.env.NODO_SERVER ?? "10.0.2.2:3005";
const pin = process.env.NODO_PIN ?? "1111";
const user = process.env.NODO_USER ?? "Juan";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (m) => console.log(`✔ ${m}`);

const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9222",
  defaultViewport: null,
});
const page =
  (await browser.pages()).find((p) => p.url().startsWith("http://localhost")) ??
  (await browser.pages())[0];
assert.ok(page, "no se encontró el WebView de la app");
// Durante una recarga el contexto de la página desaparece un instante: se trata como «sin texto todavía»
const text = () => page.evaluate(() => document.body.innerText).catch(() => "");
const until = async (cond, what, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await sleep(200);
  }
  throw new Error(
    `Tiempo agotado esperando: ${what}\n--- pantalla ---\n${(await text()).slice(0, 400)}`,
  );
};
const clickText = (sel, t) =>
  page.evaluate(
    (sel, t) => {
      const el = [...document.querySelectorAll(sel)].find((e) =>
        (e.innerText || e.placeholder || "").trim().includes(t),
      );
      if (!el) return false;
      el.click();
      return true;
    },
    sel,
    t,
  );

// 1) primera conexión: sin servidor guardado, la app lo pide
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "load" });
await until(
  async () => (await text()).includes("Conectar con el servidor"),
  "pantalla de conexión",
);
ok("la app pide el servidor la primera vez");

await page.type("input", server, { delay: 20 });
await clickText("button", "Conectar");
await until(async () => (await text()).includes("Toca tu nombre"), "acceso del servidor");
ok(`conectó con ${server} (CORS, contrato y HTTP en claro dentro de la app)`);

// 2) acceso por PIN y mapa de mesas
await clickText(".user-card", user);
await until(async () => !!(await page.$(".pad button")), "teclado de PIN");
for (const d of pin) await clickText(".pad button", d);
await clickText(".pad button", "Entrar");
await until(async () => (await text()).includes("libres"), "mapa de mesas");
ok("acceso por PIN y mapa de mesas desde el servidor");

// 3) sin red: se corta y se vuelve a abrir la pantalla; la interfaz (que es de la app) y lo último conocido siguen ahí
const cdp = await page.createCDPSession();
await cdp.send("Network.enable");
await cdp.send("Network.emulateNetworkConditions", {
  offline: true,
  latency: 0,
  downloadThroughput: 0,
  uploadThroughput: 0,
});
await page.reload({ waitUntil: "load" });
await until(async () => (await text()).includes("libres"), "mapa de mesas sin red");
await until(async () => (await text()).includes("Sin conexión"), "aviso de sin conexión");
ok("sin red: la app abre y muestra lo último conocido con el aviso");
await cdp.send("Network.emulateNetworkConditions", {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
});
await until(async () => !(await text()).includes("Sin conexión"), "reconexión", 30000);
ok("al volver la red se reconecta solo");

await browser.disconnect();
console.log("\nApp verificada en el dispositivo.");
