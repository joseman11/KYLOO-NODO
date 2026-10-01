// Renderiza las cuatro películas en orden.
import { spawnSync } from "node:child_process";
for (const s of ["pedido", "cocina", "cobro", "hero"]) {
  const r = spawnSync(process.execPath, ["render.mjs", s], { stdio: "inherit" });
  if (r.status !== 0) { console.error("falló", s); process.exit(1); }
}
console.log("TODAS LISTAS");
