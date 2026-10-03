import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { openDb } from "../src/db";
import { Hub } from "../src/hub";
import { seed } from "../src/seed";
import { API_CONTRACT } from "@003/shared";

async function make() {
  const db = await openDb(":memory:");
  await seed(db, "admin1234");
  return buildApp(db, { hub: new Hub() });
}

describe("CORS para la app envoltorio de las tablets", () => {
  it("permite el origen de la app (Capacitor) y su cabecera de autorización en el preflight", async () => {
    const app = await make();
    const r = await app.inject({
      method: "OPTIONS",
      url: "/api/floor",
      headers: {
        origin: "http://localhost",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(r.statusCode).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe("http://localhost");
    expect(String(r.headers["access-control-allow-headers"])).toContain("authorization");
    await app.close();
  });

  it("responde con la cabecera a las peticiones reales de la app", async () => {
    const app = await make();
    const r = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "capacitor://localhost" },
    });
    expect(r.headers["access-control-allow-origin"]).toBe("capacitor://localhost");
    await app.close();
  });

  it("no abre la API a cualquier origen: sin comodín y sin permitir sitios de fuera", async () => {
    const app = await make();
    for (const origin of ["https://sitio-malicioso.example", "http://192.168.1.50:3003", "null"]) {
      const r = await app.inject({ method: "GET", url: "/api/health", headers: { origin } });
      expect(r.headers["access-control-allow-origin"], origin).toBeUndefined();
    }
    const pre = await app.inject({
      method: "OPTIONS",
      url: "/api/floor",
      headers: {
        origin: "https://sitio-malicioso.example",
        "access-control-request-method": "POST",
      },
    });
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("NODO_CORS_ORIGINS añade orígenes concretos", async () => {
    process.env.NODO_CORS_ORIGINS = "http://app-propia.example:8080, https://otra.example";
    try {
      const app = await make();
      const r = await app.inject({
        method: "GET",
        url: "/api/health",
        headers: { origin: "http://app-propia.example:8080" },
      });
      expect(r.headers["access-control-allow-origin"]).toBe("http://app-propia.example:8080");
      await app.close();
    } finally {
      // biome-ignore lint/performance/noDelete: process.env no admite undefined como valor
      delete process.env.NODO_CORS_ORIGINS;
    }
  });

  it("/api/health publica la versión del contrato con la interfaz", async () => {
    const app = await make();
    const h = (await app.inject({ method: "GET", url: "/api/health" })).json();
    expect(h.contract).toBe(API_CONTRACT);
    await app.close();
  });
});
