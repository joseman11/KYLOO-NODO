/**
 * Renderiza una película HTML a .mp4 cuadro por cuadro (1920x1080, 30 fps, H.264).
 *   node render.mjs pedido            → ../public/videos/pedido.mp4 (+ póster .jpg)
 *   node render.mjs pedido --preview 2,6,10   → PNG de esos segundos en preview/
 */
import puppeteer from "puppeteer-core";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const scene = process.argv[2] || "pedido";
const prev = process.argv.indexOf("--preview");
const FPS = 30;
const OUT = join(HERE, "../public/videos");
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  args: ["--font-render-hinting=none"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
page.on("requestfailed", (q) => console.error("falla:", q.url().slice(-80)));
page.on("pageerror", (e) => console.error("pageerror:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("console:", m.text()); });
await page.goto(`${pathToFileURL(join(HERE, "film/index.html")).href}?scene=${scene}`, { waitUntil: "networkidle0" });
await page.evaluate(() => document.fonts.ready);
const duration = await page.evaluate(() => window.FILM.duration);
const frame = async (t) => {
  await page.evaluate((t) => window.FILM.render(t), t);
  return page.screenshot({ type: "jpeg", quality: 94 });
};

if (prev > 0) {
  mkdirSync(join(HERE, "preview"), { recursive: true });
  for (const s of process.argv[prev + 1].split(",")) {
    const buf = await page.evaluate((t) => window.FILM.render(t), Number(s)).then(() => page.screenshot({ type: "png" }));
    writeFileSync(join(HERE, `preview/${scene}-${s}.png`), buf);
  }
  console.log("duración", duration);
  await browser.close();
  process.exit(0);
}

const total = Math.round(duration * FPS);
const file = join(OUT, `${scene}.mp4`);
const ff = spawn(ffmpegPath, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", file], { stdio: ["pipe", "inherit", "inherit"] });
const done = new Promise((r) => ff.on("close", r));
for (let i = 0; i < total; i++) {
  const buf = await frame(i / FPS);
  if (i === Math.round(total * 0.42)) writeFileSync(join(OUT, `${scene}.jpg`), buf);
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  if (i % 60 === 0) process.stdout.write(`\r${scene}: ${i}/${total}`);
}
ff.stdin.end();
await done;
console.log(`\n${file} listo (${duration.toFixed(1)} s)`);
await browser.close();
