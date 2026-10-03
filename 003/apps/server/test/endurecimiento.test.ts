import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { openDb } from "../src/db";
import { Hub } from "../src/hub";
import { RateLimiter } from "../src/ratelimit";
import { seed } from "../src/seed";

async function make(options: Record<string, unknown> = {}) {
  const db = await openDb(":memory:");
  await seed(db, "admin1234");
  return buildApp(db, { hub: new Hub(), ...options });
}
const badLogin = (app: Awaited<ReturnType<typeof make>>, headers: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers,
    payload: { username: "nadie", password: "x" },
  });

describe("cabeceras de seguridad", () => {
  it("van en las respuestas de la API y en los errores", async () => {
    const app = await make();
    for (const url of ["/api/health", "/api/no-existe"]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.headers["x-content-type-options"], url).toBe("nosniff");
      expect(r.headers["x-frame-options"], url).toBe("DENY");
      expect(r.headers["referrer-policy"], url).toBe("no-referrer");
      expect(String(r.headers["content-security-policy"]), url).toContain("frame-ancestors 'none'");
      expect(String(r.headers["content-security-policy"]), url).toContain("script-src 'self'");
    }
    await app.close();
  });

  it("la política de contenido no deja cargar scripts de fuera y permite lo que la app usa", async () => {
    const app = await make();
    const csp = String(
      (await app.inject({ method: "GET", url: "/api/health" })).headers["content-security-policy"],
    );
    expect(csp).not.toMatch(/script-src[^;]*(unsafe-inline|unsafe-eval|\*|https?:)/);
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("connect-src 'self' ws: wss:");
    expect(csp).toContain("object-src 'none'");
    await app.close();
  });
});

describe("errores internos", () => {
  it("un fallo del servidor no revela su texto interno: devuelve un identificador", async () => {
    const app = await make();
    app.get("/api/boom", async () => {
      throw new Error("SQLITE_ERROR: no such table: secretos en /var/lib/nodo/nodo.sqlite");
    });
    const r = await app.inject({ method: "GET", url: "/api/boom" });
    expect(r.statusCode).toBe(500);
    const body = r.json();
    expect(body.error).toBe("error_interno");
    expect(body.id).toBeTruthy();
    expect(r.body).not.toContain("SQLITE");
    expect(r.body).not.toContain("/var/lib");
    await app.close();
  });

  it("los errores del usuario (400/404/409) siguen explicándose", async () => {
    const app = await make();
    const r = await app.inject({ method: "POST", url: "/api/auth/pin", payload: { userId: "x" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("validacion");
    await app.close();
  });
});

describe("límite de intentos de acceso por IP", () => {
  it("el limitador cuenta por ventana y se libera con el tiempo", () => {
    let t = 1000;
    const l = new RateLimiter(2, 10_000, () => t);
    expect(l.hit("a").ok).toBe(true);
    expect(l.hit("a").ok).toBe(true);
    const third = l.hit("a");
    expect(third.ok).toBe(false);
    expect(third.retryAfterSec).toBeGreaterThan(0);
    expect(l.hit("b").ok).toBe(true); // otra IP no se ve afectada
    t += 10_001;
    expect(l.hit("a").ok).toBe(true);
  });

  it("tras demasiados accesos fallidos desde una IP responde 429 con Retry-After", async () => {
    const app = await make({ rateLimit: { max: 3, windowMs: 60_000 } });
    for (let i = 0; i < 3; i++) expect((await badLogin(app)).statusCode).toBe(401);
    const r = await badLogin(app);
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toBe("demasiados_intentos");
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    // el resto de la API no se ve afectado
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    await app.close();
  });

  it("sin configurar no limita (pruebas y desarrollo)", async () => {
    const app = await make();
    for (let i = 0; i < 8; i++) expect((await badLogin(app)).statusCode).toBe(401);
    await app.close();
  });

  it("detrás de un proxy cada cliente real tiene su propio límite; sin proxy no se confía en X-Forwarded-For", async () => {
    const proxied = await make({ rateLimit: { max: 2, windowMs: 60_000 }, trustProxy: true });
    const from = (ip: string) => ({ "x-forwarded-for": ip });
    for (let i = 0; i < 2; i++) await badLogin(proxied, from("1.1.1.1"));
    expect((await badLogin(proxied, from("1.1.1.1"))).statusCode).toBe(429);
    expect((await badLogin(proxied, from("2.2.2.2"))).statusCode).toBe(401); // otro cliente
    await proxied.close();

    const direct = await make({ rateLimit: { max: 2, windowMs: 60_000 } });
    for (let i = 0; i < 2; i++) await badLogin(direct, from("1.1.1.1"));
    // un cliente directo no puede esquivar el límite inventándose la cabecera
    expect((await badLogin(direct, from("9.9.9.9"))).statusCode).toBe(429);
    await direct.close();
  });

  it("el PIN y el acceso de administración comparten el límite", async () => {
    const app = await make({ rateLimit: { max: 2, windowMs: 60_000 } });
    await app.inject({
      method: "POST",
      url: "/api/auth/pin",
      payload: { userId: "x", pin: "1234" },
    });
    await badLogin(app);
    expect((await badLogin(app)).statusCode).toBe(429);
    await app.close();
  });
});
