import { describe, expect, it } from "vitest";
import { openPg } from "../src/store/pg-migrate";
import { dropSchema } from "../src/store/pg";

const URL_ = process.env.TEST_DATABASE_URL ?? "postgres://postgres:nodo@127.0.0.1:5433/nodo_test";
describe("pg", () => {
  it("crea el esquema completo", async () => {
    const db = await openPg({ connectionString: URL_, schema: "r_smoke" });
    const t = (await db.prepare("SELECT count(*) c FROM information_schema.tables WHERE table_schema='r_smoke'").get()) as { c: number };
    console.log("tablas:", t.c);
    expect(t.c).toBeGreaterThan(55);
    await db.close();
    await dropSchema(URL_, "r_smoke");
  });
});
