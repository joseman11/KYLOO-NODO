/**
 * Prueba de humo del paquete construido (solo la plataforma en la que corre):
 *   node smoke.mjs [carpeta del paquete]
 * Arranca el paquete con una carpeta de datos nueva y comprueba: salud y versión, primer arranque, alta del administrador,
 * acceso, apagado ordenado, y que al volver a arrancar los datos siguen ahí y el asistente no reaparece.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(readFileSync(join(HERE, "../apps/server/package.json"), "utf8")).version;
const pkg = resolve(
  process.argv[2] ?? join(HERE, "dist", `nodo-${version}-dev-${process.platform}-${process.arch}`),
);
if (!existsSync(join(pkg, "app/server.mjs"))) throw new Error(`No es un paquete de Nodo: ${pkg}`);

const data = mkdtempSync(join(tmpdir(), "nodo-smoke-"));
const port = 3100 + Math.floor(Math.random() * 800);
const base = `http://127.0.0.1:${port}`;
const node = join(pkg, process.platform === "win32" ? "node.exe" : "node");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (path, init) =>
  fetch(base + path, init).then(async (r) => ({
    status: r.status,
    body: await r.json().catch(() => null),
  }));
const post = (path, body) =>
  json(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function start() {
  const child = spawn(
    node,
    ["--disable-warning=ExperimentalWarning", join(pkg, "app/server.mjs")],
    {
      env: { ...process.env, NODO_DATA_DIR: data, PORT: String(port), HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stderr.on("data", (d) => process.stderr.write(d));
  return child;
}
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await json("/api/health")).body?.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("el servidor no respondió en 15 s");
}
const stop = (child) =>
  new Promise((res) => {
    child.once("exit", (code) => res(code));
    child.kill("SIGTERM");
  });

const ok = (m) => console.log(`✔ ${m}`);
try {
  let child = start();
  await waitUp();
  const health = (await json("/api/health")).body;
  assert.equal(health.version, version, "la versión del paquete no coincide");
  assert.equal(health.engine, "sqlite");
  ok(`salud: versión ${health.version}, motor ${health.engine}`);

  assert.deepEqual((await json("/api/setup/status")).body, { needsSetup: true });
  assert.equal((await json("/")).status, 200);
  ok("instalación nueva: pide configuración y sirve la app web");

  const setup = await post("/api/setup", {
    establishment: "Prueba",
    adminName: "Admin",
    username: "admin",
    password: "clave-de-prueba-9",
  });
  assert.equal(setup.status, 201);
  const login = await post("/api/auth/login", { username: "admin", password: "clave-de-prueba-9" });
  assert.equal(login.status, 200);
  ok("alta del administrador y acceso");

  // El modo de licencia del paquete coincide con lo que dice su VERSION y, sin activar, no impide operar
  const expected = /producción/.test(readFileSync(join(pkg, "VERSION"), "utf8"))
    ? "enforced"
    : "open";
  const status = await json("/api/cloud/status", {
    headers: { authorization: `Bearer ${login.body.token}` },
  });
  assert.equal(status.body.mode, expected, "el modo de licencia no es el esperado");
  if (expected === "enforced") {
    assert.equal(status.body.license?.restricted, true, "sin activar debe quedar restringido");
    assert.equal(status.body.license?.plan, "gratis");
  }
  ok(
    `licencia: modo ${status.body.mode}${expected === "enforced" ? " (restringido hasta activar, sin bloquear)" : ""}`,
  );

  const code = await stop(child);
  assert.equal(code, 0, `apagado ordenado esperado (código 0), salió con ${code}`);
  const log = readFileSync(join(data, "logs/nodo.log"), "utf8");
  assert.match(log, /"msg":"apagado completo"/);
  ok("apagado ordenado con SIGTERM (código 0, registrado)");

  child = start();
  await waitUp();
  assert.deepEqual((await json("/api/setup/status")).body, { needsSetup: false });
  assert.equal(
    (await post("/api/auth/login", { username: "admin", password: "clave-de-prueba-9" })).status,
    200,
  );
  ok("al reiniciar, los datos siguen y el asistente no reaparece");
  await stop(child);
  console.log("\nPaquete verificado.");
} finally {
  rmSync(data, { recursive: true, force: true });
}
