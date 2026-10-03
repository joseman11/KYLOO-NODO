import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { openDb } from "../src/db";
import { Hub } from "../src/hub";
import { lanAddresses, startMdns } from "../src/mdns";
import { seed } from "../src/seed";

describe("conexión de dispositivos", () => {
  it("las direcciones de la red local no incluyen la de retorno ni las de enlace local", () => {
    for (const a of lanAddresses()) {
      expect(a).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(a.startsWith("127.")).toBe(false);
      expect(a.startsWith("169.254.")).toBe(false);
    }
  });

  it("anunciar por mDNS nunca lanza y se puede detener", () => {
    const errors: unknown[] = [];
    const h = startMdns(3999, (e) => errors.push(e), "nodo-prueba.local");
    expect(h === null || h.host === "nodo-prueba.local").toBe(true);
    h?.stop();
  });

  it("/api/network publica el nombre .local cuando el servidor lo anuncia, y solo a quien tiene sesión", async () => {
    const db = await openDb(":memory:");
    await seed(db, "admin1234");
    const app = buildApp(db, { hub: new Hub(), mdnsHost: "nodo.local" });
    expect((await app.inject({ method: "GET", url: "/api/network" })).statusCode).toBe(401);
    const token = (
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: "admin1234" },
      })
    ).json().token;
    const r = (
      await app.inject({
        method: "GET",
        url: "/api/network",
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
    expect(r.mdns).toBe("nodo.local");
    expect(Array.isArray(r.addresses)).toBe(true);
    await app.close();
  });

  it("sin anuncio mDNS el nombre es null", async () => {
    const db = await openDb(":memory:");
    await seed(db, "admin1234");
    const app = buildApp(db, { hub: new Hub() });
    const token = (
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: "admin1234" },
      })
    ).json().token;
    const r = (
      await app.inject({
        method: "GET",
        url: "/api/network",
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
    expect(r.mdns).toBeNull();
    await app.close();
  });
});
