import { afterAll } from "vitest";

// Con PostgreSQL, cada «base en memoria» es un esquema con su grupo de conexiones: al terminar cada archivo se cierran las
// que alguna prueba dejó abiertas (ver closeTempPgDbs).
afterAll(async () => {
  if (!process.env.NODO_PG_URL) return;
  const { closeTempPgDbs } = await import("../src/store/pg-migrate");
  await closeTempPgDbs();
});
