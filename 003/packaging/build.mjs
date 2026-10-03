/**
 * Construye el paquete instalable del servidor de Nodo para una plataforma:
 *
 *   node build.mjs (--license-public-key <pem>[,<pem>…] | --license open) [--hq-url <url>]
 *                  [--platform win32|darwin|linux] [--arch x64|arm64] [--skip-web] [--node 24.21.0]
 *
 * Licencia (obligatoria elegir): un paquete de PRODUCCIÓN lleva incrustada la clave pública de Nodo (`--license-public-key`)
 * y exige una licencia atada al equipo; un paquete de DESARROLLO (`--license open`) no limita nada y se marca «-dev» en
 * el nombre para no distribuirlo por error.
 *
 * Resultado en `dist/nodo-<versión>-<plataforma>-<arquitectura>/` (y su .zip/.tar.gz con suma SHA-256):
 *   node(.exe)        el Node oficial de esa plataforma, descargado y verificado contra SHASUMS256.txt de nodejs.org
 *   app/server.mjs    el servidor entero en un solo archivo (esbuild); sin node_modules ni compilar nada en el local
 *   app/web/          la app web compilada
 *   (Windows) nodo-service.exe + .xml (WinSW), install.ps1 y uninstall.ps1
 *
 * No hay módulos nativos (SQLite es `node:sqlite`), así que un paquete de Windows se puede construir desde macOS o Linux.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleServer } from "./bundle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CACHE = join(HERE, ".cache");
const OUT = join(HERE, "dist");

/** Node que se empaqueta. Es el que usan las pruebas (`.nvmrc` fija la línea 24); se sube a propósito, no solo. */
const NODE_VERSION = "24.21.0";

/**
 * WinSW (envoltorio de servicios de Windows, MIT). SHA-256 del ejecutable x64 de la versión fijada: se calculó la primera vez
 * que se descargó (confianza en el primer uso) y desde entonces cualquier cambio en el archivo hace fallar la construcción.
 */
const WINSW = {
  version: "2.12.0",
  url: "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe",
  sha256: "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da",
};

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const platform = opt("platform", process.platform);
const arch = opt("arch", process.arch);
const nodeVersion = opt("node", NODE_VERSION);
const keyFiles = opt("license-public-key", "");
const licenseOpen = opt("license", "") === "open";
if (!keyFiles && !licenseOpen)
  throw new Error(
    "Falta elegir la licencia: --license-public-key <archivo.pem> (producción) o --license open (desarrollo, no distribuir)",
  );
const publicKeys = keyFiles ? keyFiles.split(",").map((f) => readFileSync(f.trim(), "utf8")) : [];
if (publicKeys.some((k) => !k.includes("BEGIN PUBLIC KEY")))
  throw new Error(
    "--license-public-key debe apuntar a una clave PÚBLICA en PEM (nunca la privada)",
  );
const hqUrl = opt("hq-url", "");
if (!["win32", "darwin", "linux"].includes(platform))
  throw new Error(`Plataforma no soportada: ${platform}`);
if (!["x64", "arm64"].includes(arch)) throw new Error(`Arquitectura no soportada: ${arch}`);

const version = JSON.parse(readFileSync(join(ROOT, "apps/server/package.json"), "utf8")).version;
const name = `nodo-${version}${licenseOpen ? "-dev" : ""}-${platform}-${arch}`;
const dir = join(OUT, name);

const log = (m) => console.log(`▸ ${m}`);
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

async function download(url, file) {
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  log(`descargando ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/** Node oficial de la plataforma: solo el ejecutable, verificado contra la suma publicada por nodejs.org. */
async function fetchNode() {
  const base = `https://nodejs.org/dist/v${nodeVersion}`;
  const ext = platform === "win32" ? "zip" : platform === "darwin" ? "tar.gz" : "tar.xz";
  const plat = platform === "win32" ? "win" : platform;
  const stem = `node-v${nodeVersion}-${plat}-${arch}`;
  const archive = join(CACHE, `${stem}.${ext}`);
  await download(`${base}/${stem}.${ext}`, archive);
  await download(`${base}/SHASUMS256.txt`, join(CACHE, `SHASUMS256-${nodeVersion}.txt`));
  const sums = readFileSync(join(CACHE, `SHASUMS256-${nodeVersion}.txt`), "utf8");
  const expected = sums
    .split("\n")
    .find((l) => l.endsWith(`  ${stem}.${ext}`))
    ?.split(/\s+/)[0];
  if (!expected) throw new Error(`nodejs.org no publica ${stem}.${ext}`);
  if (sha256(archive) !== expected) {
    rmSync(archive);
    throw new Error(
      `La suma SHA-256 de ${stem}.${ext} no coincide con la publicada: se descartó la descarga`,
    );
  }
  const tmp = join(CACHE, `x-${stem}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  if (platform === "win32") {
    execFileSync("unzip", ["-q", "-j", archive, `${stem}/node.exe`, "-d", tmp]);
    return join(tmp, "node.exe");
  }
  execFileSync("tar", ["-xf", archive, "-C", tmp, "--strip-components=2", `${stem}/bin/node`]);
  return join(tmp, "node");
}

async function main() {
  log(`paquete ${name} (Node ${nodeVersion})`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "app"), { recursive: true });

  // 1) App web compilada
  if (!args.includes("--skip-web")) {
    log("compilando la app web");
    execFileSync("npx", ["-y", "pnpm@11.21.0", "--filter", "@003/web", "build"], {
      cwd: ROOT,
      stdio: "inherit",
    });
  }
  const webDist = join(ROOT, "apps/web/dist");
  if (!existsSync(join(webDist, "index.html")))
    throw new Error("Falta la app web compilada (apps/web/dist)");
  cpSync(webDist, join(dir, "app/web"), { recursive: true });

  // 2) Servidor en un solo archivo
  log("empaquetando el servidor (esbuild)");
  await bundleServer({
    outfile: join(dir, "app/server.mjs"),
    define: {
      // Producción: modo y claves quedan fijos en el ejecutable; ninguna variable de entorno los cambia
      ...(licenseOpen
        ? {}
        : {
            "process.env.NODO_LICENSE_MODE": JSON.stringify("enforced"),
            "process.env.NODO_LICENSE_PUBLIC_KEYS": JSON.stringify(JSON.stringify(publicKeys)),
          }),
      ...(hqUrl ? { "process.env.NODO_HQ_URL": JSON.stringify(hqUrl) } : {}),
    },
  });

  // 3) Node oficial
  const nodeBin = await fetchNode();
  cpSync(nodeBin, join(dir, platform === "win32" ? "node.exe" : "node"));
  if (platform !== "win32") chmodSync(join(dir, "node"), 0o755);

  // 4) Archivos de la plataforma
  writeFileSync(
    join(dir, "VERSION"),
    `${version}\nNode ${nodeVersion}\nlicencia: ${licenseOpen ? "ABIERTA (desarrollo, no distribuir)" : "producción (clave incrustada)"}\n`,
  );
  if (platform === "win32") {
    const winsw = join(CACHE, `WinSW-${WINSW.version}-x64.exe`);
    await download(WINSW.url, winsw);
    if (!WINSW.sha256.startsWith("WINSW_") && sha256(winsw) !== WINSW.sha256) {
      rmSync(winsw);
      throw new Error(
        "La suma SHA-256 de WinSW no coincide con la fijada: se descartó la descarga",
      );
    }
    if (WINSW.sha256.startsWith("WINSW_"))
      log(`SHA-256 de WinSW (fíjala en build.mjs): ${sha256(winsw)}`);
    cpSync(winsw, join(dir, "nodo-service.exe"));
    for (const f of ["nodo-service.xml", "install.ps1", "uninstall.ps1", "nodo.cmd"]) {
      const text = readFileSync(join(HERE, "templates", f), "utf8").replaceAll(
        "{{VERSION}}",
        version,
      );
      // PowerShell 5 lee mejor los scripts con BOM y saltos de línea de Windows
      writeFileSync(
        join(dir, f),
        f.endsWith(".ps1") ? `﻿${text.replaceAll("\n", "\r\n")}` : text.replaceAll("\n", "\r\n"),
      );
    }
  } else {
    const text = readFileSync(join(HERE, "templates/nodo.sh"), "utf8").replaceAll(
      "{{VERSION}}",
      version,
    );
    writeFileSync(join(dir, "nodo.sh"), text);
    chmodSync(join(dir, "nodo.sh"), 0o755);
  }

  // 4b) Instalador .exe de Windows (NSIS), si makensis está disponible en este equipo
  if (platform === "win32") {
    const exe = `Nodo-Setup-${version}${licenseOpen ? "-dev" : ""}.exe`;
    try {
      const nsi = readFileSync(join(HERE, "templates/installer.nsi"), "utf8")
        .replaceAll("{{VERSION}}", version)
        .replaceAll("{{PKG}}", dir)
        .replaceAll("{{OUT}}", join(OUT, exe));
      const nsiFile = join(CACHE, "installer.nsi");
      writeFileSync(nsiFile, nsi);
      execFileSync("makensis", ["-V1", nsiFile], { stdio: "inherit" });
      writeFileSync(join(OUT, `${exe}.sha256`), `${sha256(join(OUT, exe))}  ${exe}\n`);
      log(`instalador: ${join(OUT, exe)}`);
    } catch (e) {
      log(
        `instalador .exe NO generado (¿makensis instalado? brew install makensis): ${e.code ?? e.message}`,
      );
    }
  }

  // 5) Archivo distribuible y suma de verificación
  const archive = platform === "win32" ? `${name}.zip` : `${name}.tar.gz`;
  rmSync(join(OUT, archive), { force: true });
  if (platform === "win32") execFileSync("zip", ["-q", "-r", archive, name], { cwd: OUT });
  else execFileSync("tar", ["-czf", archive, name], { cwd: OUT });
  writeFileSync(join(OUT, `${archive}.sha256`), `${sha256(join(OUT, archive))}  ${archive}\n`);

  const size = (p) => execFileSync("du", ["-sk", p]).toString().split("\t")[0];
  log(`listo: ${join(OUT, archive)}`);
  log(
    `carpeta ${Math.round(size(dir) / 1024)} MB; archivo ${Math.round(size(join(OUT, archive)) / 1024)} MB`,
  );
  log(`contiene: ${readdirSync(dir).join(", ")}`);
}

main().catch((e) => {
  console.error(`✖ ${e.message}`);
  process.exit(1);
});
