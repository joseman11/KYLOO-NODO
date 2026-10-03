import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { openDb, type Db } from "../src/db";
import { seed } from "../src/seed";

let app: FastifyInstance;
let db: Db;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const call = async (t: string, method: Method, url: string, payload?: unknown) => {
  const r = await app.inject({
    method,
    url,
    headers: { Authorization: `Bearer ${t}` },
    payload: payload as object,
  });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};
const admin = async () =>
  (
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "admin1234" },
    })
  ).json().token as string;
async function pin(name: string, p: string) {
  const users = (await app.inject({ method: "GET", url: "/api/auth/users" })).json() as {
    id: string;
    name: string;
  }[];
  return (
    await app.inject({
      method: "POST",
      url: "/api/auth/pin",
      payload: { userId: users.find((x) => x.name === name)!.id, pin: p },
    })
  ).json().token as string;
}

beforeEach(async () => {
  db = await openDb(":memory:");
  await seed(db, "admin1234");
  app = buildApp(db);
});

describe("áreas de servicio y sus mesas", () => {
  it("crea áreas con prefijo y genera sus mesas numeradas, siguiendo la numeración", async () => {
    const t = await admin();
    const terraza = (await call(t, "POST", "/api/zones", { name: "Terraza", prefix: "T" })).body
      .id as string;
    const r = await call(t, "POST", "/api/tables/bulk", {
      zone_id: terraza,
      count: 4,
      capacity: 6,
    });
    expect(r.body.created).toEqual(["T1", "T2", "T3", "T4"]);

    // otra tanda continúa en T5; y no pisa mesas existentes si se pide un inicio repetido
    expect(
      (await call(t, "POST", "/api/tables/bulk", { zone_id: terraza, count: 2 })).body.created,
    ).toEqual(["T5", "T6"]);
    const again = (
      await call(t, "POST", "/api/tables/bulk", { zone_id: terraza, count: 3, start: 5 })
    ).body;
    expect(again).toEqual({ created: ["T7"], skipped: ["T5", "T6"] });

    const tables = (await call(t, "GET", "/api/tables")).body as {
      number: string;
      zone_id: string;
      capacity: number;
    }[];
    const mine = tables.filter((x) => x.zone_id === terraza);
    expect(mine).toHaveLength(7);
    expect(mine[0]).toMatchObject({ number: "T1", capacity: 6 });
  });

  it("ordena las mesas de forma natural (T2 antes que T10) también en el mapa", async () => {
    const t = await admin();
    const z = (await call(t, "POST", "/api/zones", { name: "Barra", prefix: "B" })).body
      .id as string;
    await call(t, "POST", "/api/tables/bulk", { zone_id: z, count: 12 });
    const nums = ((await call(t, "GET", "/api/tables")).body as { number: string }[])
      .filter((x) => x.number.startsWith("B"))
      .map((x) => x.number);
    expect(nums.slice(0, 3)).toEqual(["B1", "B2", "B3"]);
    expect(nums.indexOf("B2")).toBeLessThan(nums.indexOf("B10"));
    const floor = ((await call(t, "GET", "/api/floor")).body as { number: string }[])
      .filter((x) => x.number.startsWith("B"))
      .map((x) => x.number);
    expect(floor).toEqual(nums);
  });

  it("crea una mesa suelta en un área, la mueve a otra y rechaza números repetidos con un mensaje claro", async () => {
    const t = await admin();
    const a = (await call(t, "POST", "/api/zones", { name: "Salón", prefix: "S" })).body
      .id as string;
    const b = (await call(t, "POST", "/api/zones", { name: "Terraza", prefix: "T" })).body
      .id as string;
    const mesa = (
      await call(t, "POST", "/api/tables", { zone_id: a, number: "S1", capacity: 2, vip: true })
    ).body.id as string;
    const dup = await call(t, "POST", "/api/tables", { zone_id: b, number: "S1" });
    expect(dup.status).toBe(409);
    expect(dup.body.message).toBe("Ya existe una mesa con ese número");

    expect(
      (await call(t, "PATCH", `/api/tables/${mesa}`, { zone_id: b, number: "T1", capacity: 8 }))
        .status,
    ).toBe(200);
    const moved = (
      (await call(t, "GET", "/api/tables")).body as {
        id: string;
        zone_id: string;
        number: string;
        capacity: number;
        vip: number;
      }[]
    ).find((x) => x.id === mesa)!;
    expect(moved).toMatchObject({ zone_id: b, number: "T1", capacity: 8, vip: 1 });
  });

  it("no repite nombres de áreas ni borra un área con mesas", async () => {
    const t = await admin();
    const z = (await call(t, "POST", "/api/zones", { name: "Patio", prefix: "P" })).body
      .id as string;
    expect((await call(t, "POST", "/api/zones", { name: "patio" })).status).toBe(400);
    await call(t, "POST", "/api/tables/bulk", { zone_id: z, count: 2 });
    const del = await call(t, "DELETE", `/api/zones/${z}`);
    expect(del.status).toBe(409);
    expect(del.body.message).toContain("2 mesa");
    // al quedar vacía sí se puede
    for (const x of (await call(t, "GET", "/api/tables")).body as { id: string; zone_id: string }[])
      if (x.zone_id === z) await call(t, "DELETE", `/api/tables/${x.id}`);
    expect((await call(t, "DELETE", `/api/zones/${z}`)).status).toBe(200);
  });

  it("una mesa con historial no se elimina: se marca fuera de servicio y deja de poder abrirse", async () => {
    const t = await admin();
    const juan = await pin("Juan", "1111");
    const tables = (await call(t, "GET", "/api/tables")).body as { id: string }[];
    const id = tables[0]!.id;
    await call(juan, "POST", `/api/tables/${id}/open`, {});
    const del = await call(t, "DELETE", `/api/tables/${id}`);
    expect(del.status).toBe(409);
    expect(del.body.message).toContain("historial");
    // con cuenta abierta tampoco se puede sacar de servicio
    expect((await call(t, "POST", `/api/tables/${id}/service`, { out: true })).status).toBe(409);

    const libre = tables[1]!.id;
    expect((await call(t, "POST", `/api/tables/${libre}/service`, { out: true })).status).toBe(200);
    const blocked = await call(juan, "POST", `/api/tables/${libre}/open`, {});
    expect(blocked.status).toBe(409);
    expect((await call(t, "POST", `/api/tables/${libre}/service`, { out: false })).status).toBe(
      200,
    );
    expect((await call(juan, "POST", `/api/tables/${libre}/open`, {})).status).toBe(201);
  });

  it("solo quien administra el local crea áreas y mesas", async () => {
    const juan = await pin("Juan", "1111");
    expect((await call(juan, "POST", "/api/zones", { name: "X" })).status).toBe(403);
    expect((await call(juan, "POST", "/api/tables/bulk", { zone_id: "z", count: 1 })).status).toBe(
      403,
    );
  });
});

describe("juntar mesas", () => {
  it("une una mesa libre a la cuenta, la libera al separar y al cerrar la cuenta", async () => {
    const adm = await admin();
    const juan = await pin("Juan", "1111");
    const tables = (await call(adm, "GET", "/api/tables")).body as { id: string; number: string }[];
    const [t1, t2, t3] = ["1", "2", "3"].map((n) => tables.find((t) => t.number === n)!);
    const acc = (await call(juan, "POST", `/api/tables/${t1!.id}/open`, { guests: 4 })).body
      .id as string;

    expect(
      (await call(juan, "POST", `/api/accounts/${acc}/join`, { tableId: t2!.id })).status,
    ).toBe(200);
    let floor = (await call(juan, "GET", "/api/floor")).body as {
      number: string;
      status: string;
      linked_to: string | null;
      joined: string[];
      accounts: { id: string }[];
    }[];
    expect(floor.find((t) => t.number === "2")).toMatchObject({
      status: "ocupada",
      linked_to: "1",
    });
    expect(floor.find((t) => t.number === "2")!.accounts[0]!.id).toBe(acc);
    expect(floor.find((t) => t.number === "1")!.joined).toEqual(["2"]);
    // la mesa unida ya no se puede abrir por separado
    expect((await call(juan, "POST", `/api/tables/${t2!.id}/open`, { guests: 2 })).status).toBe(
      409,
    );

    // separar la libera
    expect((await call(juan, "POST", `/api/tables/${t2!.id}/unjoin`, {})).status).toBe(200);
    floor = (await call(juan, "GET", "/api/floor")).body;
    expect(floor.find((t) => t.number === "2")!.status).toBe("disponible");

    // fusionar con una mesa que ya tiene cuenta deja ambas mesas juntas
    const other = (await call(juan, "POST", `/api/tables/${t3!.id}/open`, { guests: 2 })).body
      .id as string;
    expect(
      (await call(juan, "POST", `/api/accounts/${acc}/merge`, { sourceAccountId: other })).status,
    ).toBe(200);
    floor = (await call(juan, "GET", "/api/floor")).body;
    expect(floor.find((t) => t.number === "3")).toMatchObject({
      status: "ocupada",
      linked_to: "1",
    });
    expect(floor.find((t) => t.number === "1")!.accounts[0]!.id).toBe(acc);
  });
});
