/**
 * Prueba que el modo de licencia de un paquete de producción queda FIJO en el ejecutable (invariante I3.3 del plan 03):
 * ninguna variable de entorno puede apagarlo ni cambiar las claves, y un paquete «enforced» sin claves no arranca.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dir = mkdtempSync(join(tmpdir(), "nodo-lic-"));

async function bundle(define) {
  const out = join(dir, `b-${Math.random().toString(36).slice(2)}.mjs`);
  await build({
    stdin: {
      contents:
        'import { loadLicensing } from "./licensing.ts"; console.log(JSON.stringify(await loadLicensing()));',
      resolveDir: join(ROOT, "apps/server/src"),
      loader: "ts",
    },
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    define,
    logLevel: "silent",
  });
  return out;
}
const run = (file, env) =>
  execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", file], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });

const REAL = "-----BEGIN PUBLIC KEY-----\nREAL\n-----END PUBLIC KEY-----\n";
const ATTACKER = "-----BEGIN PUBLIC KEY-----\nATACANTE\n-----END PUBLIC KEY-----\n";

test("producción: el modo y las claves no se cambian con variables de entorno", async () => {
  const file = await bundle({
    "process.env.NODO_LICENSE_MODE": JSON.stringify("enforced"),
    "process.env.NODO_LICENSE_PUBLIC_KEYS": JSON.stringify(JSON.stringify([REAL])),
  });
  const out = JSON.parse(
    run(file, {
      NODO_LICENSE: "open", // intento de apagar la licencia
      NODO_LICENSE_PUBLIC_KEYS: JSON.stringify([ATTACKER]), // intento de sustituir la clave
      NODO_LICENSE_MODE: "open",
    }),
  );
  assert.equal(out.mode, "enforced");
  assert.deepEqual(out.publicKeys, [REAL]);
});

test("producción sin claves: no arranca (error de construcción, no degradación silenciosa)", async () => {
  const file = await bundle({ "process.env.NODO_LICENSE_MODE": JSON.stringify("enforced") });
  assert.throws(() => run(file, {}), /sin claves públicas/);
});

test("desarrollo: sin modo horneado, la licencia está abierta salvo que se pida lo contrario", async () => {
  const file = await bundle({});
  assert.equal(JSON.parse(run(file, {})).mode, "open");
  const forced = JSON.parse(
    run(file, { NODO_LICENSE: "enforced", NODO_LICENSE_PUBLIC_KEYS: JSON.stringify([REAL]) }),
  );
  assert.equal(forced.mode, "enforced");
  assert.deepEqual(forced.publicKeys, [REAL]);
});

test("el constructor exige elegir licencia y rechaza una clave privada", () => {
  const env = { PATH: process.env.PATH };
  assert.throws(
    () =>
      execFileSync(process.execPath, ["build.mjs", "--skip-web"], {
        cwd: join(ROOT, "packaging"),
        env,
        stdio: "pipe",
      }),
    /Falta elegir la licencia/,
  );
  const priv = join(dir, "priv.pem");
  writeFileSync(priv, "-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----\n");
  assert.throws(
    () =>
      execFileSync(process.execPath, ["build.mjs", "--skip-web", "--license-public-key", priv], {
        cwd: join(ROOT, "packaging"),
        env,
        stdio: "pipe",
      }),
    /clave PÚBLICA/,
  );
});
