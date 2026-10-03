import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { openDb } from "../src/db";
import type { Db } from "../src/db";
import { Hub } from "../src/hub";
import type { FastifyInstance } from "fastify";

let db: Db;
let app: FastifyInstance;
beforeEach(async () => {
  db = await openDb(":memory:"); // sin sembrar: es una instalación nueva
  app = buildApp(db, { hub: new Hub() });
});
afterEach(async () => {
  await app.close();
});

const valid = {
  establishment: "Mariscos El Faro",
  adminName: "Ana Pérez",
  username: "Ana.Perez",
  password: "una-clave-larga-1",
};
const post = (payload: unknown) =>
  app.inject({ method: "POST", url: "/api/setup", payload: payload as object });

describe("primer arranque", () => {
  it("una instalación nueva pide configuración y no trae ningún usuario", async () => {
    expect((await app.inject({ method: "GET", url: "/api/setup/status" })).json()).toEqual({
      needsSetup: true,
    });
    expect((await db.prepare("SELECT COUNT(*) c FROM users").get()) as { c: number }).toEqual({
      c: 0,
    });
  });

  it("crea al administrador con su contraseña y el nombre del local, y permite entrar", async () => {
    const r = await post(valid);
    expect(r.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/api/setup/status" })).json()).toEqual({
      needsSetup: false,
    });
    expect((await app.inject({ method: "GET", url: "/api/auth/info" })).json()).toEqual({
      name: "Mariscos El Faro",
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ana.perez", password: valid.password },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user).toMatchObject({ name: "Ana Pérez", role: "admin" });
  });

  it("la contraseña no queda en claro y el alta queda en la bitácora", async () => {
    await post(valid);
    const u = (await db.prepare("SELECT password_hash FROM users").get()) as {
      password_hash: string;
    };
    expect(u.password_hash).not.toContain(valid.password);
    const a = (await db
      .prepare("SELECT action FROM audit_log WHERE action='setup.completed'")
      .get()) as { action: string } | undefined;
    expect(a?.action).toBe("setup.completed");
  });

  it("solo funciona una vez: después responde 409 y no crea otro administrador", async () => {
    expect((await post(valid)).statusCode).toBe(201);
    const second = await post({ ...valid, username: "otro", password: "otra-clave-larga-2" });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("ya_configurado");
    expect(((await db.prepare("SELECT COUNT(*) c FROM users").get()) as { c: number }).c).toBe(1);
  });

  it("dos solicitudes a la vez: solo una crea el administrador", async () => {
    const [a, b] = await Promise.all([
      post(valid),
      post({ ...valid, username: "segundo", password: "otra-clave-larga-2" }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(((await db.prepare("SELECT COUNT(*) c FROM users").get()) as { c: number }).c).toBe(1);
  });

  it("no acepta contraseñas cortas ni las más comunes", async () => {
    expect((await post({ ...valid, password: "corta1" })).statusCode).toBe(400);
    expect((await post({ ...valid, password: "admin1234" })).statusCode).toBe(400);
    expect((await post({ ...valid, password: "12345678" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/setup/status" })).json().needsSetup).toBe(
      true,
    );
  });

  it("valida el usuario y los textos", async () => {
    expect((await post({ ...valid, username: "a" })).statusCode).toBe(400);
    expect((await post({ ...valid, username: "con espacio" })).statusCode).toBe(400);
    expect((await post({ ...valid, establishment: "  " })).statusCode).toBe(400);
    expect((await post({})).statusCode).toBe(400);
  });

  it("una instalación sembrada (demo) ya no pide configuración", async () => {
    const { seed } = await import("../src/seed");
    await seed(db);
    expect((await app.inject({ method: "GET", url: "/api/setup/status" })).json().needsSetup).toBe(
      false,
    );
    expect((await post(valid)).statusCode).toBe(409);
  });
});
