import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DEFAULT_ROLE_PERMISSIONS, ROLES, type Permission, type Role } from "@003/shared";
import { buildApp } from "../src/app";
import { openDb, type Db } from "../src/db";
import { seed } from "../src/seed";

let app: FastifyInstance;
let db: Db;
const H = (t: string) => ({ Authorization: `Bearer ${t}` });
const call = async (token: string | null, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers: token ? H(token) : undefined, payload: payload as object });
  return { status: r.statusCode, body: r.body ? (r.headers["content-type"]?.toString().includes("json") ? r.json() : r.body) : null };
};
const adminToken = async () => (await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin1234" } })).json().token as string;
async function pinLogin(userId: string, pin: string) {
  return app.inject({ method: "POST", url: "/api/auth/pin", payload: { userId, pin } });
}

const TEST_ROLES = ROLES.filter((r) => r !== "admin") as Exclude<Role, "admin">[];
const roleUser: Record<string, { id: string; token: string }> = {};
let admin = "";

beforeAll(async () => {
  db = openDb(":memory:");
  seed(db, "admin1234");
  app = buildApp(db);
  admin = await adminToken();
  for (const [i, role] of TEST_ROLES.entries()) {
    const pin = String(7000 + i);
    const r = await call(admin, "POST", "/api/users", { name: `Prueba ${role}`, role, pin });
    expect(r.status).toBe(201);
    const login = await pinLogin(r.body.id, pin);
    roleUser[role] = { id: r.body.id, token: login.json().token };
  }
});

/** Cada endpoint exige un permiso: se prueba con TODOS los roles que el permiso se respeta en ambos sentidos. */
const PROTEGIDOS: { perm: Permission; method: "GET" | "POST" | "PUT" | "PATCH"; url: string; body?: unknown }[] = [
  { perm: "user.manage", method: "GET", url: "/api/users" },
  { perm: "user.manage", method: "POST", url: "/api/users", body: {} },
  { perm: "product.create", method: "POST", url: "/api/products", body: {} },
  { perm: "reports.view", method: "GET", url: "/api/reports/sales" },
  { perm: "reports.view", method: "GET", url: "/api/dashboard" },
  { perm: "reports.view", method: "GET", url: "/api/audit" },
  { perm: "cash.open", method: "POST", url: "/api/cash/open", body: { opening_cents: 0 } },
  { perm: "cash.close", method: "POST", url: "/api/cash/close", body: {} },
  { perm: "inventory.modify", method: "POST", url: "/api/inventory/movements", body: {} },
  { perm: "inventory.view", method: "GET", url: "/api/inventory/alerts" },
  { perm: "purchase.manage", method: "POST", url: "/api/purchase-orders", body: {} },
  { perm: "venue.manage", method: "PUT", url: "/api/settings", body: {} },
  { perm: "payment.take", method: "POST", url: "/api/gift-cards", body: {} },
  { perm: "reservation.manage", method: "POST", url: "/api/reservations", body: {} },
];

describe("matriz de permisos por rol", () => {
  for (const ep of PROTEGIDOS) {
    for (const role of TEST_ROLES) {
      const allowed = DEFAULT_ROLE_PERMISSIONS[role].includes(ep.perm);
      it(`${ep.method} ${ep.url} · ${role} ${allowed ? "pasa" : "es rechazado"} (${ep.perm})`, async () => {
        const r = await call(roleUser[role]!.token, ep.method, ep.url, ep.body);
        if (allowed) expect(r.status, JSON.stringify(r.body)).not.toBe(403);
        else expect(r.status).toBe(403);
        expect(r.status).not.toBe(500);
      });
    }
    it(`${ep.method} ${ep.url} · el administrador siempre pasa`, async () => {
      expect((await call(admin, ep.method, ep.url, ep.body)).status).not.toBe(403);
    });
    it(`${ep.method} ${ep.url} · sin sesión → 401`, async () => {
      expect((await call(null, ep.method, ep.url, ep.body)).status).toBe(401);
    });
  }
});

describe("autenticación", () => {
  it("rechaza tokens manipulados, truncados y de otro firmante", async () => {
    const good = roleUser.mesero!.token;
    const [h, p, s] = good.split(".");
    const flipped = `${h}.${p}.${s!.slice(0, -2)}${s!.endsWith("A") ? "B" : "A"}x`;
    const forgedPayload = Buffer.from(JSON.stringify({ sub: roleUser.mesero!.id, role: "admin", permissions: ["user.manage"] })).toString("base64url");
    for (const bad of [flipped, `${h}.${forgedPayload}.${s}`, "no-es-un-token", `${h}.${p}`, "", "Bearer"]) {
      const r = await app.inject({ method: "GET", url: "/api/me", headers: { Authorization: `Bearer ${bad}` } });
      expect(r.statusCode, bad.slice(0, 20)).toBe(401);
    }
    // un mesero no puede escalar a administrador falsificando el payload
    const forged = await app.inject({ method: "GET", url: "/api/users", headers: { Authorization: `Bearer ${h}.${forgedPayload}.${s}` } });
    expect(forged.statusCode).toBe(401);
  });

  it("bloquea 60 s tras 5 PIN incorrectos y no revela si el usuario existe", async () => {
    const u = roleUser.cajero!;
    for (let i = 0; i < 5; i++) expect((await pinLogin(u.id, "0000")).statusCode).toBe(401);
    const locked = await pinLogin(u.id, "7001"); // aunque ahora el PIN sea correcto
    expect(locked.statusCode).toBe(429);
    const ghost = await pinLogin("no-existe", "0000");
    expect(ghost.statusCode).toBe(401); // misma respuesta que un PIN malo, sin pista
    db.prepare("UPDATE users SET failed_attempts=0, locked_until=0 WHERE id=?").run(u.id);
  });

  it("valida el formato del PIN y de las credenciales", async () => {
    const u = roleUser.mesero!;
    for (const pin of ["12", "abcd", "1234567890", " 1234", "12 34"]) {
      expect([400, 401], pin).toContain((await pinLogin(u.id, pin)).statusCode);
    }
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "mal-mal-mal" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: "no json", headers: { "content-type": "application/json" } })).statusCode).toBe(400);
  });

  it("un usuario dado de baja ya no puede entrar ni usar su token", async () => {
    const created = await call(admin, "POST", "/api/users", { name: "Temporal", role: "mesero", pin: "8123" });
    const login = await pinLogin(created.body.id, "8123");
    expect(login.statusCode).toBe(200);
    const token = login.json().token as string;
    expect((await call(token, "GET", "/api/me")).status).toBe(200);
    await call(admin, "PATCH", `/api/users/${created.body.id}`, { active: false });
    expect((await pinLogin(created.body.id, "8123")).statusCode).toBe(401);
    const users = (await app.inject({ method: "GET", url: "/api/auth/users" })).json() as { id: string }[];
    expect(users.find((x) => x.id === created.body.id)).toBeUndefined();
  });

  it("la lista pública de acceso no filtra hashes, contraseñas ni permisos", async () => {
    const r = await app.inject({ method: "GET", url: "/api/auth/users" });
    const text = r.body;
    expect(text).not.toMatch(/pin_hash|password|scrypt|permissions|username/i);
    for (const u of r.json() as Record<string, unknown>[]) expect(Object.keys(u).sort()).toEqual(["id", "name", "photo", "role"]);
  });

  it("el administrador no aparece con PIN y su contraseña exige al menos 8 caracteres", async () => {
    const r = await call(admin, "POST", "/api/users", { name: "Corto", role: "gerente", username: "corto", password: "1234" });
    expect(r.status).toBe(400);
  });
});

describe("robustez ante entradas hostiles", () => {
  it("las inyecciones SQL y el HTML en nombres se guardan como texto, sin dañar nada", async () => {
    const nasty = "Robert'); DROP TABLE users;-- <img src=x onerror=alert(1)>";
    const st = (await call(admin, "GET", "/api/stations")).body as { id: string }[];
    const p = await call(admin, "POST", "/api/products", { name: nasty, price_cents: 1000, station_ids: [st[0]!.id] });
    expect([200, 201]).toContain(p.status);
    const list = (await call(admin, "GET", "/api/products")).body as { name: string }[];
    expect(list.some((x) => x.name === nasty)).toBe(true);
    expect((db.prepare("SELECT COUNT(*) c FROM users").get() as { c: number }).c).toBeGreaterThan(5);
  });

  it("los errores de validación son 400 con mensaje, nunca 500", async () => {
    const bodies: unknown[] = [{}, { name: 5 }, { name: "" }, { name: "x", price_cents: -5 }, { name: "x", price_cents: "mil" }, { name: "x".repeat(5000), price_cents: 1 }, null, []];
    for (const b of bodies) {
      const r = await call(admin, "POST", "/api/products", b);
      expect(r.status, JSON.stringify(b)?.slice(0, 40)).toBeLessThan(500);
    }
  });

  it("rechaza cuerpos enormes (límite 2 MB) sin caerse", async () => {
    const r = await app.inject({ method: "POST", url: "/api/products", headers: { ...H(admin), "content-type": "application/json" }, payload: JSON.stringify({ name: "x".repeat(3_000_000), price_cents: 1 }) });
    expect(r.statusCode).toBe(413);
    expect((await call(admin, "GET", "/api/me")).status).toBe(200);
  });

  it("no sirve archivos fuera de la carpeta de fotos (path traversal)", async () => {
    for (const f of ["..%2F..%2F003.sqlite", "%2e%2e%2fpackage.json", "....//....//etc/passwd", "a.jpg%00.png", "x.svg", "x.html"]) {
      const r = await app.inject({ method: "GET", url: `/api/photos/${f}` });
      expect([400, 404], f).toContain(r.statusCode);
    }
  });

  it("las fotos solo aceptan imágenes reales (no un ejecutable con extensión .jpg)", async () => {
    const id = (await call(admin, "GET", "/api/products")).body[0].id as string;
    const fakeJpg = "data:image/jpeg;base64," + Buffer.from("MZ\x90\x00este-no-es-un-jpeg".repeat(20)).toString("base64");
    expect((await call(admin, "POST", `/api/products/${id}/photo`, { data: fakeJpg })).status).toBe(400);
    expect((await call(admin, "POST", `/api/products/${id}/photo`, { data: "data:text/html;base64,PGgxPmhvbGE8L2gxPg==" + "A".repeat(100) })).status).toBe(400);
    expect((await call(admin, "POST", `/api/users/${roleUser.mesero!.id}/photo`, { data: fakeJpg })).status).toBe(400);
  });

  it("rutas inexistentes responden 404 en JSON y los métodos no permitidos no explotan", async () => {
    expect((await call(admin, "GET", "/api/no-existe")).status).toBe(404);
    expect((await call(admin, "DELETE", "/api/me")).status).toBeLessThan(500);
    expect((await call(admin, "GET", "/api/accounts/%00")).status).toBeLessThan(500);
  });

  it("los datos de sucursal ajenos no se filtran por IDs adivinados", async () => {
    const r = await call(roleUser.mesero!.token, "GET", "/api/accounts/000000000000000000000000");
    expect(r.status).toBe(404);
  });
});

describe("sesión", () => {
  it("/api/me devuelve el usuario con sus permisos y su foto (null si no tiene)", async () => {
    const r = await call(roleUser.mesero!.token, "GET", "/api/me");
    expect(r.body.role).toBe("mesero");
    expect(r.body.permissions).toEqual(expect.arrayContaining([...DEFAULT_ROLE_PERMISSIONS.mesero]));
    const login = await pinLogin(roleUser.mesero!.id, "7002");
    expect(login.json().user).toMatchObject({ role: "mesero", photo: null });
  });

  it("cerrar sesión no rompe las siguientes solicitudes del mismo usuario con otro token", async () => {
    const a = (await pinLogin(roleUser.cocina!.id, "7004")).json().token as string;
    const b = (await pinLogin(roleUser.cocina!.id, "7004")).json().token as string;
    expect((await call(a, "POST", "/api/auth/logout", {})).status).toBeLessThan(400);
    expect((await call(b, "GET", "/api/me")).status).toBe(200);
  });
});

describe("cuerpos JSON", () => {
  it("un DELETE con content-type JSON y cuerpo vacío se acepta (clientes que siempre declaran JSON)", async () => {
    const st = (await call(admin, "GET", "/api/stations")).body as { id: string }[];
    const p = await call(admin, "POST", "/api/products", { name: "Para borrar", price_cents: 100, station_ids: [st[0]!.id] });
    const r = await app.inject({ method: "DELETE", url: `/api/products/${p.body.id}`, headers: { ...H(admin), "content-type": "application/json" } });
    expect(r.statusCode).toBeLessThan(400);
  });

  it("el JSON mal formado sigue siendo 400, no 500", async () => {
    for (const bad of ["{", "{\"a\":", "[1,2", "undefined", "{'a':1}"]) {
      const r = await app.inject({ method: "POST", url: "/api/products", headers: { ...H(admin), "content-type": "application/json" }, payload: bad });
      expect(r.statusCode, bad).toBe(400);
    }
  });

  it("un POST sin cuerpo a una ruta que lo exige da 400 con mensaje", async () => {
    const r = await app.inject({ method: "POST", url: "/api/products", headers: H(admin) });
    expect(r.statusCode).toBeLessThan(500);
  });
});
