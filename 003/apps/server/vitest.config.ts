import { defineConfig } from "vitest/config";

// Con PostgreSQL (NODO_PG_URL) cada prueba crea un esquema completo: se da más margen
const pg = !!process.env.NODO_PG_URL;
export default defineConfig({
  test: {
    testTimeout: pg ? 60_000 : 5_000,
    hookTimeout: pg ? 120_000 : 10_000,
    fileParallelism: !pg,
  },
});
