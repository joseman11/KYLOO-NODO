/**
 * Empaqueta el servidor en un solo archivo (esbuild). Lo usan `build.mjs` (paquete instalable de un local) y el Dockerfile del
 * HQ (nube): así los dos ejecutan exactamente el mismo código.
 *
 *   node bundle.mjs <carpeta de salida>      → <salida>/server.mjs y <salida>/web/ (la app compilada)
 */
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..");
export const serverVersion = () =>
  JSON.parse(readFileSync(join(ROOT, "apps/server/package.json"), "utf8")).version;

export async function bundleServer({ outfile, define = {} }) {
  await build({
    entryPoints: [join(ROOT, "apps/server/src/main.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: false,
    minify: false, // el minificado ahorra poco y empeora los errores de un local; la ofuscación va aparte (plan 03, D3.7)
    legalComments: "none",
    define: { "process.env.NODO_VERSION": JSON.stringify(serverVersion()), ...define },
    // Algunas dependencias CommonJS usan `require` dentro del paquete ESM
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    logLevel: "warning",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] ?? "");
  if (!process.argv[2]) throw new Error("Uso: node bundle.mjs <carpeta de salida>");
  const web = join(ROOT, "apps/web/dist");
  if (!existsSync(join(web, "index.html")))
    throw new Error("Falta compilar la app web (apps/web/dist)");
  mkdirSync(out, { recursive: true });
  await bundleServer({ outfile: join(out, "server.mjs") });
  cpSync(web, join(out, "web"), { recursive: true });
  console.log(`Servidor y app web en ${out}`);
}
