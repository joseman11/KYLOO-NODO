/**
 * Genera TODOS los iconos de Nodo desde la misma geometría (la «o» sartén con su huevo), sin editar nada a mano:
 *
 *   CHROME_PATH=<Chrome> node scripts/make-icons.mjs
 *
 * Salidas: icono maestro y favicon de la web y de la landing, iconos PWA (normal y «maskable»), icono de Apple, los de
 * lanzador de Android (clásicos, redondos, adaptativos con primer plano y versión monocroma) y las pantallas de inicio.
 * El render lo hace Chrome (SVG → PNG), así los bordes salen suaves a cualquier tamaño.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const WEB_PUBLIC = join(ROOT, "apps/web/public");
const LANDING_BRAND = resolve(ROOT, "../landing/public/brand");
const RES = join(ROOT, "apps/mobile/android/app/src/main/res");

const INK = "#0b0b0c"; // fondo del icono (negro de la marca, un punto más cálido que #000 puro)
const CREAM = "#f4f2ec"; // trazo de la sartén
const EGG = "#ff5900"; // el «nodo»

/**
 * La sartén: círculo de radio 40 con mango, y el huevo en el centro (coordenadas del logotipo, ver src/Logo.tsx).
 * Su caja ocupa x 357..538, y 48..140 (con los remates redondeados); su centro es (447.5, 94).
 */
const BOX = { cx: 447.5, cy: 94, w: 181 };
const mark = ({ pan = CREAM, egg = EGG } = {}) => `
  <g stroke="${pan}" stroke-width="26" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <circle cx="410" cy="100" r="40"/>
    <line x1="448" y1="92" x2="526" y2="68" stroke-width="24"/>
  </g>
  <circle cx="410" cy="100" r="15" fill="${egg}"/>`;

/** La sartén centrada en un lienzo cuadrado de `size`, ocupando `fill` del ancho. */
const placed = (size, fill, colors) => {
  const s = (size * fill) / BOX.w;
  return `<g transform="translate(${size / 2 - BOX.cx * s} ${size / 2 - BOX.cy * s}) scale(${s})">${mark(colors)}</g>`;
};

const svg = (size, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`;

/** Icono maestro: cuadrado de bordes redondeados (rx ≈ 22 %) con la sartén centrada (68 % del ancho). */
const masterSvg = (size = 1024, { rounded = true } = {}) =>
  svg(
    size,
    `<rect width="${size}" height="${size}" rx="${rounded ? size * 0.225 : 0}" fill="${INK}"/>${placed(size, 0.68)}`,
  );
/** Para iconos que el sistema recorta él mismo (maskable, adaptativo): fondo a sangre y sartén dentro de la zona segura (≈ 56 %). */
const bleedSvg = (size, fill = 0.56) =>
  svg(size, `<rect width="${size}" height="${size}" fill="${INK}"/>${placed(size, fill)}`);
/** Primer plano adaptativo: transparente, sartén dentro de los 66 dp centrales de 108 dp. */
const foregroundSvg = (size) => svg(size, placed(size, 0.46));
/** Monocromo (Android 13, iconos con tema): solo forma, el sistema la tiñe. El huevo queda como hueco opaco más pequeño. */
const monochromeSvg = (size) => svg(size, placed(size, 0.46, { pan: "#000", egg: "#000" }));
const roundSvg = (size) =>
  svg(
    size,
    `<clipPath id="c"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}"/></clipPath><g clip-path="url(#c)"><rect width="${size}" height="${size}" fill="${INK}"/>${placed(size, 0.56)}</g>`,
  );
/** Pantalla de inicio: fondo de la marca con la sartén al centro (≈ 22 % del lado menor). */
const splashSvg = (w, h) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${INK}"/>${(() => {
    const m = Math.min(w, h);
    const s = (m * 0.26) / BOX.w;
    return `<g transform="translate(${w / 2 - BOX.cx * s} ${h / 2 - BOX.cy * s}) scale(${s})">${mark()}</g>`;
  })()}</svg>`;

const chrome =
  process.env.CHROME_PATH ??
  [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
  ].find((p) => existsSync(p));
if (!chrome) throw new Error("Define CHROME_PATH");
const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage();

const write = (file, data) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
};
/** Renderiza un SVG a PNG con fondo transparente. */
async function png(file, markup, width, height = width) {
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block}</style>${markup}`,
  );
  write(
    file,
    await page.screenshot({
      type: "png",
      omitBackground: true,
      clip: { x: 0, y: 0, width, height },
    }),
  );
  console.log(`  ${file.replace(`${resolve(ROOT, "..")}/`, "")} (${width}×${height})`);
}

console.log("Maestro y web");
write(join(WEB_PUBLIC, "icon.svg"), masterSvg(512));
write(join(LANDING_BRAND, "icon.svg"), masterSvg(512));
await png(join(WEB_PUBLIC, "icon-192.png"), masterSvg(192), 192);
await png(join(WEB_PUBLIC, "icon-512.png"), masterSvg(512), 512);
await png(join(WEB_PUBLIC, "icon-maskable-512.png"), bleedSvg(512, 0.52), 512);
await png(join(WEB_PUBLIC, "apple-touch-icon.png"), bleedSvg(180, 0.6), 180); // iOS le pone sus propias esquinas
await png(join(WEB_PUBLIC, "favicon-32.png"), masterSvg(32), 32);

console.log("Android: iconos de lanzador");
const DENS = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(DENS)) {
  const dir = join(RES, `mipmap-${d}`);
  await png(join(dir, "ic_launcher.png"), masterSvg(Math.round(48 * k)), Math.round(48 * k));
  await png(join(dir, "ic_launcher_round.png"), roundSvg(Math.round(48 * k)), Math.round(48 * k));
  await png(
    join(dir, "ic_launcher_foreground.png"),
    foregroundSvg(Math.round(108 * k)),
    Math.round(108 * k),
  );
  await png(
    join(dir, "ic_launcher_monochrome.png"),
    monochromeSvg(Math.round(108 * k)),
    Math.round(108 * k),
  );
}
write(
  join(RES, "values/ic_launcher_background.xml"),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${INK}</color>\n</resources>\n`,
);
const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
`;
write(join(RES, "mipmap-anydpi-v26/ic_launcher.xml"), adaptive);
write(join(RES, "mipmap-anydpi-v26/ic_launcher_round.xml"), adaptive);

console.log("Android: pantallas de inicio");
const SPLASH = {
  drawable: [480, 320],
  "drawable-land-mdpi": [480, 320],
  "drawable-land-hdpi": [800, 480],
  "drawable-land-xhdpi": [1280, 720],
  "drawable-land-xxhdpi": [1600, 960],
  "drawable-land-xxxhdpi": [1920, 1280],
  "drawable-port-mdpi": [320, 480],
  "drawable-port-hdpi": [480, 800],
  "drawable-port-xhdpi": [720, 1280],
  "drawable-port-xxhdpi": [960, 1600],
  "drawable-port-xxxhdpi": [1280, 1920],
};
for (const [dir, [w, h]] of Object.entries(SPLASH))
  await png(join(RES, dir, "splash.png"), splashSvg(w, h), w, h);

await browser.close();
console.log("Listo.");
