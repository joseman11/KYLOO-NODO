import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { type Db, openDb } from "../src/db";
import {
  fingerprintOf,
  parseDarwinUuid,
  parseWindowsGuid,
  shortFingerprint,
} from "../src/fingerprint";
import { Hub } from "../src/hub";
import {
  GRACE_DAYS,
  type LicensePayload,
  type LicensingContext,
  PLANS,
  generateSigningKeys,
  getLicense,
  noteClock,
  signLicense,
} from "../src/license";
import { type HttpLike, syncWithHq } from "../src/routes/cloud";
import { seed } from "../src/seed";

const FP_A = fingerprintOf("maquina-a");
const FP_B = fingerprintOf("maquina-b");
const DAY = 86_400_000;
const KEYS = generateSigningKeys();
const OTHER = generateSigningKeys();

const payload = (over: Partial<LicensePayload> = {}): LicensePayload => ({
  org: "o",
  branch: "b",
  plan: "profesional",
  limits: { users: PLANS.profesional!.users, printers: PLANS.profesional!.printers },
  features: PLANS.profesional!.features,
  iat: Date.now(),
  exp: Date.now() + 30 * DAY,
  fp: FP_A,
  ...over,
});
const enforced = (
  fingerprint: string | null = FP_A,
  publicKeys = [KEYS.publicKey],
): LicensingContext => ({
  mode: "enforced",
  publicKeys,
  fingerprint,
});
const put = (db: Db, key: string, value: string) =>
  db
    .prepare(
      "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(key, value);

describe("huella del equipo", () => {
  it("es estable, de 32 hex y no revela el identificador", () => {
    const fp = fingerprintOf("0F7D2C9E-AAAA-BBBB");
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
    expect(fingerprintOf(" 0f7d2c9e-aaaa-bbbb \n")).toBe(fp);
    expect(fp).not.toContain("0f7d2c9e");
    expect(fingerprintOf("otro")).not.toBe(fp);
  });
  it("la forma corta se puede dictar", () => {
    expect(shortFingerprint("a1b2c3d4e5f60718293a4b5c6d7e8f90")).toBe("A1B2-C3D4-E5F6");
  });
  it("lee el identificador de Windows y de macOS", () => {
    const win = `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    4c4c4544-0042-3510-8056-b4c04f4d3232\r\n`;
    expect(parseWindowsGuid(win)).toBe("4c4c4544-0042-3510-8056-b4c04f4d3232");
    const mac = `  | "IOPlatformUUID" = "9A7B6C5D-1111-2222-3333-444455556666"`;
    expect(parseDarwinUuid(mac)).toBe("9A7B6C5D-1111-2222-3333-444455556666");
    expect(parseWindowsGuid("sin datos")).toBeNull();
  });
});

describe("estado de la licencia", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb(":memory:");
  });
  const install = (p: LicensePayload, key = KEYS.privateKey) =>
    put(db, "license", signLicense(key, p));

  it("modo open (desarrollo): sin licencia no hay límites", async () => {
    expect(await getLicense(db)).toBeNull();
  });

  it("modo enforced: sin licencia queda el plan gratis, restringido, no bloqueado", async () => {
    const l = await getLicense(db, Date.now(), enforced());
    expect(l).toMatchObject({ plan: "gratis", restricted: true, reason: "sin_licencia" });
    expect(l?.features).toEqual([]);
    expect(l?.limits.users).toBe(PLANS.gratis!.users);
  });

  it("una licencia válida para este equipo se respeta", async () => {
    await install(payload());
    const l = await getLicense(db, Date.now(), enforced());
    expect(l).toMatchObject({ plan: "profesional", expired: false });
    expect(l?.restricted).toBeUndefined();
  });

  it("firmada con una clave que no está incrustada: restringido", async () => {
    await install(payload(), OTHER.privateKey);
    expect(await getLicense(db, Date.now(), enforced())).toMatchObject({
      restricted: true,
      reason: "firma_invalida",
    });
  });

  it("un atacante no puede sustituir la clave: hq_public_key de la base se ignora en enforced", async () => {
    await put(db, "hq_public_key", OTHER.publicKey);
    await install(payload({ plan: "empresarial" }), OTHER.privateKey);
    expect(await getLicense(db, Date.now(), enforced())).toMatchObject({
      restricted: true,
      reason: "firma_invalida",
    });
    // en modo open (desarrollo) esa clave sí se usa, como siempre
    expect(await getLicense(db)).toMatchObject({ plan: "empresarial" });
  });

  it("atada al equipo: otra huella o ninguna restringe", async () => {
    await install(payload({ fp: FP_B }));
    expect(await getLicense(db, Date.now(), enforced(FP_A))).toMatchObject({
      restricted: true,
      reason: "otro_equipo",
    });
    await install(payload({ fp: null }));
    expect(await getLicense(db, Date.now(), enforced())).toMatchObject({ reason: "sin_huella" });
    await install(payload());
    expect(await getLicense(db, Date.now(), enforced(null))).toMatchObject({
      reason: "otro_equipo",
    });
  });

  it("vencida: sigue operando durante la gracia y después queda restringida", async () => {
    const exp = Date.now() - 1000;
    await install(payload({ exp }));
    expect(await getLicense(db, Date.now(), enforced())).toMatchObject({
      plan: "profesional",
      expired: true,
    });
    const later = exp + (GRACE_DAYS + 1) * DAY;
    expect(await getLicense(db, later, enforced())).toMatchObject({
      restricted: true,
      reason: "vencida",
    });
  });

  it("suscripción anual: la gracia es de 15 días y después queda restringida", async () => {
    expect(GRACE_DAYS).toBe(15);
    const exp = Date.now() - 1000;
    await install(payload({ exp }));
    expect(await getLicense(db, exp + 14 * DAY, enforced())).toMatchObject({
      plan: "profesional",
      expired: true,
    });
    expect(await getLicense(db, exp + 16 * DAY, enforced())).toMatchObject({ reason: "vencida" });
  });

  it("revocada por Nodo: queda restringida aunque la licencia siga vigente", async () => {
    await install(payload());
    await put(db, "license_revoked", "1");
    expect(await getLicense(db, Date.now(), enforced())).toMatchObject({
      restricted: true,
      reason: "revocada",
    });
  });

  it("retrasar el reloj no alarga una licencia vencida", async () => {
    const exp = Date.now() + 1 * DAY;
    await install(payload({ exp }));
    const future = exp + (GRACE_DAYS + 3) * DAY;
    await noteClock(db, future); // el sistema vio esa hora alguna vez
    // el reloj del equipo se retrasa a «hoy»
    expect(await getLicense(db, Date.now(), enforced())).toMatchObject({
      restricted: true,
      reason: "vencida",
    });
  });

  it("noteClock solo avanza", async () => {
    await noteClock(db, 2000);
    await noteClock(db, 1000);
    const v = (await db
      .prepare("SELECT value FROM settings WHERE key='license_clock_hwm'")
      .get()) as {
      value: string;
    };
    expect(v.value).toBe("2000");
  });

  it("acepta varias claves (rotación)", async () => {
    await install(payload(), OTHER.privateKey);
    const l = await getLicense(db, Date.now(), enforced(FP_A, [KEYS.publicKey, OTHER.publicKey]));
    expect(l).toMatchObject({ plan: "profesional" });
  });
});

// ───────────────────────── Activación con HQ ─────────────────────────
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const ADMIN = { "x-hq-admin": "secreto-plataforma" };
const bridge =
  (target: FastifyInstance): HttpLike =>
  async (url, init) => {
    const u = new URL(url);
    const r = await target.inject({
      method: (init?.method ?? "GET") as Method,
      url: u.pathname + u.search,
      headers: init?.headers,
      payload: init?.body,
    });
    return { ok: r.statusCode < 400, status: r.statusCode, json: async () => r.json() };
  };

describe("activación de una sucursal con código", () => {
  let hqApp: FastifyInstance;
  let hqDb: Db;
  let ownerToken: string;
  let branchId: string;
  let code: string;
  let branchKey: string;

  async function makeLocal(fingerprint: string, licensing: Partial<LicensingContext> = {}) {
    const db = await openDb(":memory:");
    await seed(db, "clave-del-local-1");
    const app = buildApp(db, {
      hub: new Hub(),
      http: bridge(hqApp),
      licensing: { mode: "enforced", publicKeys: [KEYS.publicKey], fingerprint, ...licensing },
      hqUrl: "http://hq.test",
    });
    const token = (
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: "clave-del-local-1" },
      })
    ).json().token as string;
    const call = (method: Method, url: string, body?: unknown) =>
      app.inject({
        method,
        url,
        headers: { Authorization: `Bearer ${token}` },
        payload: body as object,
      });
    return { app, db, token, call };
  }

  beforeEach(async () => {
    hqDb = await openDb(":memory:");
    hqApp = buildApp(hqDb, {
      hub: new Hub(),
      hq: { adminToken: "secreto-plataforma", signingKey: KEYS.privateKey, keyId: "k1" },
    });
    const org = await hqApp.inject({
      method: "POST",
      url: "/api/hq/orgs",
      headers: ADMIN,
      payload: {
        name: "Mariscos",
        plan: "profesional",
        owner: { username: "dueno", password: "clave-segura-1" },
      },
    });
    expect(org.statusCode).toBe(201);
    ownerToken = (
      await hqApp.inject({
        method: "POST",
        url: "/api/hq/login",
        payload: { username: "dueno", password: "clave-segura-1" },
      })
    ).json().token as string;
    const br = await hqApp.inject({
      method: "POST",
      url: "/api/hq/branches",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { name: "Centro" },
    });
    expect(br.statusCode).toBe(201);
    ({ id: branchId, activation_code: code, api_key: branchKey } = br.json());
  });

  it("al crear la sucursal el HQ entrega un código con formato NODO-XXXX-XXXX-XXXX", () => {
    expect(code).toMatch(/^NODO-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });

  it("el HQ solo guarda el hash del código", async () => {
    const rows = (await hqDb.prepare("SELECT code_hash FROM hq_activation_codes").all()) as {
      code_hash: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code_hash).not.toContain(code.replace(/-/g, ""));
  });

  it("canjear el código activa el equipo, guarda la licencia y deja de pedir restricciones", async () => {
    const local = await makeLocal(FP_A);
    // antes: restringido
    let st = (await local.call("GET", "/api/cloud/status")).json();
    expect(st.license).toMatchObject({ restricted: true, reason: "sin_licencia", plan: "gratis" });

    const r = await local.call("POST", "/api/license/activate", { code });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      ok: true,
      plan: "profesional",
      org: "Mariscos",
      branch: "Centro",
    });

    st = (await local.call("GET", "/api/cloud/status")).json();
    expect(st.mode).toBe("enforced");
    expect(st.linked).toBe(true);
    expect(st.license).toMatchObject({ plan: "profesional", restricted: false, reason: null });
    expect(st.fingerprint).toBe(shortFingerprint(FP_A));
    // la llave que quedó en el local no es la que se mostró al crear la sucursal (se rotó al activar)
    const stored = (await local.db
      .prepare("SELECT value FROM settings WHERE key='hq_key'")
      .get()) as {
      value: string;
    };
    expect(stored.value).not.toBe(branchKey);
    // y la licencia emitida lleva la huella y la clave
    const lic = await getLicense(local.db, Date.now(), enforced(FP_A));
    expect(lic).toMatchObject({ plan: "profesional", fp: FP_A, kid: "k1" });
  });

  it("la licencia emitida funciona en modo enforced: sin red no cambia nada", async () => {
    const local = await makeLocal(FP_A);
    await local.call("POST", "/api/license/activate", { code });
    const analytics = await local.call("GET", "/api/analytics/overview");
    expect(analytics.statusCode).not.toBe(402); // profesional incluye analítica
  });

  it("un código se canjea una sola vez", async () => {
    const a = await makeLocal(FP_A);
    expect((await a.call("POST", "/api/license/activate", { code })).statusCode).toBe(200);
    const b = await makeLocal(FP_B);
    const again = await b.call("POST", "/api/license/activate", { code });
    expect(again.statusCode).toBe(404);
    expect(again.json().error).toBe("codigo_invalido");
  });

  it("acepta el código con o sin guiones y en minúsculas", async () => {
    const local = await makeLocal(FP_A);
    const r = await local.call("POST", "/api/license/activate", {
      code: code.replace(/-/g, "").toLowerCase(),
    });
    expect(r.statusCode).toBe(200);
  });

  it("un código inventado o vencido no activa nada y no revela cuál fue el motivo", async () => {
    const local = await makeLocal(FP_A);
    const wrong = await local.call("POST", "/api/license/activate", {
      code: "NODO-AAAA-BBBB-CCCC",
    });
    expect(wrong.statusCode).toBe(404);
    await hqDb.prepare("UPDATE hq_activation_codes SET expires_at=?").run(Date.now() - 1000);
    const expired = await local.call("POST", "/api/license/activate", { code });
    expect(expired.statusCode).toBe(404);
    expect(expired.json().error).toBe(wrong.json().error);
    const st = (await local.call("GET", "/api/cloud/status")).json();
    expect(st.license.restricted).toBe(true);
  });

  it("sin Internet la activación falla con un mensaje claro y no deja nada a medias", async () => {
    const local = await makeLocal(FP_A);
    const offline = buildApp(local.db, {
      hub: new Hub(),
      http: async () => {
        throw new Error("sin red");
      },
      licensing: enforced(FP_A),
      hqUrl: "http://hq.test",
    });
    const r = await offline.inject({
      method: "POST",
      url: "/api/license/activate",
      headers: { Authorization: `Bearer ${local.token}` },
      payload: { code },
    });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toBe("hq_inalcanzable");
    expect(
      await local.db.prepare("SELECT value FROM settings WHERE key='license'").get(),
    ).toBeUndefined();
    // el código no se gastó: se puede reintentar con red
    const retry = await local.call("POST", "/api/license/activate", { code });
    expect(retry.statusCode).toBe(200);
  });

  it("copiar la licencia a otro equipo no sirve: queda restringido por otra huella", async () => {
    const a = await makeLocal(FP_A);
    await a.call("POST", "/api/license/activate", { code });
    const token = (
      (await a.db.prepare("SELECT value FROM settings WHERE key='license'").get()) as {
        value: string;
      }
    ).value;
    const b = await makeLocal(FP_B);
    await put(b.db, "license", token);
    expect(await getLicense(b.db, Date.now(), enforced(FP_B))).toMatchObject({
      restricted: true,
      reason: "otro_equipo",
    });
  });

  it("la renovación por sincronización exige el mismo equipo", async () => {
    const a = await makeLocal(FP_A);
    await a.call("POST", "/api/license/activate", { code });
    const ok = await syncWithHq(a.db, bridge(hqApp), enforced(FP_A));
    expect(ok.license).toMatchObject({ ok: true, plan: "profesional" });

    // un equipo distinto con la misma llave: el HQ responde 403 y no entrega licencia
    const stolen = await makeLocal(FP_B);
    const key = (
      (await a.db.prepare("SELECT value FROM settings WHERE key='hq_key'").get()) as {
        value: string;
      }
    ).value;
    await put(stolen.db, "hq_url", "http://hq.test");
    await put(stolen.db, "hq_key", key);
    const bad = await syncWithHq(stolen.db, bridge(hqApp), enforced(FP_B));
    expect(bad.license.ok).toBe(false);
    expect(bad.license.error).toMatch(/403/);
  });

  it("cambio de equipo: un código nuevo ata la sucursal a otra huella y la llave anterior deja de valer", async () => {
    const a = await makeLocal(FP_A);
    await a.call("POST", "/api/license/activate", { code });
    const oldKey = (
      (await a.db.prepare("SELECT value FROM settings WHERE key='hq_key'").get()) as {
        value: string;
      }
    ).value;

    // el dueño pide un código nuevo (equipo descompuesto)
    const re = await hqApp.inject({
      method: "POST",
      url: `/api/hq/branches/${branchId}/activation-code`,
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(re.statusCode).toBe(200);
    const b = await makeLocal(FP_B);
    expect(
      (await b.call("POST", "/api/license/activate", { code: re.json().code })).statusCode,
    ).toBe(200);

    // el equipo anterior ya no puede renovar: su llave fue rotada
    const gone = await syncWithHq(a.db, bridge(hqApp), enforced(FP_A));
    expect(gone.license.ok).toBe(false);
    const withOld = await hqApp.inject({
      method: "GET",
      url: "/api/hq/license",
      headers: { "x-branch-key": oldKey, "x-device-fp": FP_A },
    });
    expect(withOld.statusCode).toBe(401);
  });

  it("un código nuevo anula el anterior sin usar", async () => {
    const re = await hqApp.inject({
      method: "POST",
      url: `/api/hq/branches/${branchId}/activation-code`,
      headers: ADMIN,
    });
    expect(re.statusCode).toBe(200);
    const local = await makeLocal(FP_A);
    expect((await local.call("POST", "/api/license/activate", { code })).statusCode).toBe(404);
    expect(
      (await local.call("POST", "/api/license/activate", { code: re.json().code })).statusCode,
    ).toBe(200);
  });

  it("solo el propietario de la organización (o la plataforma) emite códigos", async () => {
    const none = await hqApp.inject({
      method: "POST",
      url: `/api/hq/branches/${branchId}/activation-code`,
    });
    expect(none.statusCode).toBe(401);
    // propietario de otra organización
    await hqApp.inject({
      method: "POST",
      url: "/api/hq/orgs",
      headers: ADMIN,
      payload: {
        name: "Otra",
        plan: "gratis",
        owner: { username: "otro", password: "clave-segura-2" },
      },
    });
    const other = (
      await hqApp.inject({
        method: "POST",
        url: "/api/hq/login",
        payload: { username: "otro", password: "clave-segura-2" },
      })
    ).json().token as string;
    const r = await hqApp.inject({
      method: "POST",
      url: `/api/hq/branches/${branchId}/activation-code`,
      headers: { Authorization: `Bearer ${other}` },
    });
    expect(r.statusCode).toBe(404);
  });

  it("valida la huella y limita los intentos", async () => {
    const bad = await hqApp.inject({
      method: "POST",
      url: "/api/hq/activate",
      payload: { code, fingerprint: "no-es-hex" },
    });
    expect(bad.statusCode).toBe(400);
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (
        await hqApp.inject({
          method: "POST",
          url: "/api/hq/activate",
          payload: { code: "NODO-ZZZZ-ZZZZ-ZZZZ", fingerprint: FP_A },
        })
      ).statusCode;
    }
    expect(last).toBe(429);
  });

  it("una sucursal o una organización suspendida no puede activarse", async () => {
    await hqApp.inject({
      method: "PATCH",
      url: `/api/hq/branches/${branchId}`,
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { active: false },
    });
    const local = await makeLocal(FP_A);
    expect((await local.call("POST", "/api/license/activate", { code })).statusCode).toBe(404);
  });

  it("el HQ no expone la huella completa al listar sucursales", async () => {
    const local = await makeLocal(FP_A);
    await local.call("POST", "/api/license/activate", { code });
    const list = (
      await hqApp.inject({
        method: "GET",
        url: "/api/hq/branches",
        headers: { Authorization: `Bearer ${ownerToken}` },
      })
    ).json() as { activated: boolean; fingerprint_short: string; fingerprint?: string }[];
    expect(list[0]).toMatchObject({ activated: true, fingerprint_short: shortFingerprint(FP_A) });
    expect(list[0]!.fingerprint).toBeUndefined();
  });

  it("restringido no es bloqueado: un local sin licencia sigue pudiendo vender", async () => {
    const local = await makeLocal(FP_A);
    const tables = (await local.call("GET", "/api/tables")).json() as { id: string }[];
    expect(
      (await local.call("POST", `/api/tables/${tables[0]!.id}/open`, { guests: 2 })).statusCode,
    ).toBe(201);
    // pero las funciones de pago están cerradas
    const r = await local.call("GET", "/api/analytics/overview");
    expect(r.statusCode).toBe(402);
    expect(r.json()).toMatchObject({ error: "plan_no_incluye", feature: "analitica" });
  });

  it("la licencia vence el día hasta el que está pagada la suscripción", async () => {
    const paidUntil = Date.now() + 200 * DAY;
    const orgs = (await hqDb.prepare("SELECT id FROM hq_orgs").get()) as { id: string };
    expect(
      (
        await hqApp.inject({
          method: "PATCH",
          url: `/api/hq/orgs/${orgs.id}`,
          headers: ADMIN,
          payload: { paid_until: paidUntil },
        })
      ).statusCode,
    ).toBe(200);
    const local = await makeLocal(FP_A);
    await local.call("POST", "/api/license/activate", { code });
    const lic = await getLicense(local.db, Date.now(), enforced(FP_A));
    expect(lic?.exp).toBe(paidUntil);
    // al renovar el pago, la siguiente sincronización trae la nueva fecha
    const renewed = paidUntil + 365 * DAY;
    await hqApp.inject({
      method: "PATCH",
      url: `/api/hq/orgs/${orgs.id}`,
      headers: ADMIN,
      payload: { paid_until: renewed },
    });
    await syncWithHq(local.db, bridge(hqApp), enforced(FP_A));
    expect((await getLicense(local.db, Date.now(), enforced(FP_A)))?.exp).toBe(renewed);
  });

  it("si Nodo desactiva la organización, la siguiente sincronización la deja revocada; reactivarla la restablece", async () => {
    const local = await makeLocal(FP_A);
    await local.call("POST", "/api/license/activate", { code });
    const org = (await hqDb.prepare("SELECT id FROM hq_orgs").get()) as { id: string };
    await hqApp.inject({
      method: "PATCH",
      url: `/api/hq/orgs/${org.id}`,
      headers: ADMIN,
      payload: { active: false },
    });
    const rep = await syncWithHq(local.db, bridge(hqApp), enforced(FP_A));
    expect(rep.license.ok).toBe(false);
    expect(await getLicense(local.db, Date.now(), enforced(FP_A))).toMatchObject({
      restricted: true,
      reason: "revocada",
    });
    // sin Internet NO es revocación: solo un 401/403 del HQ lo es
    await hqApp.inject({
      method: "PATCH",
      url: `/api/hq/orgs/${org.id}`,
      headers: ADMIN,
      payload: { active: true },
    });
    await syncWithHq(local.db, bridge(hqApp), enforced(FP_A));
    expect(await getLicense(local.db, Date.now(), enforced(FP_A))).toMatchObject({
      plan: "profesional",
    });
  });

  it("un fallo de red al renovar no revoca nada", async () => {
    const local = await makeLocal(FP_A);
    await local.call("POST", "/api/license/activate", { code });
    const down: HttpLike = async () => {
      throw new Error("sin red");
    };
    await syncWithHq(local.db, down, enforced(FP_A));
    expect(await getLicense(local.db, Date.now(), enforced(FP_A))).toMatchObject({
      plan: "profesional",
    });
  });

  it("el estado de la nube publica los días de gracia para el aviso de vencimiento", async () => {
    const local = await makeLocal(FP_A);
    await local.call("POST", "/api/license/activate", { code });
    const st = (await local.call("GET", "/api/cloud/status")).json();
    expect(st.grace_days).toBe(GRACE_DAYS);
    expect(st.license.expires_at).toBeGreaterThan(Date.now());
  });

  it("el HQ firma con la clave del entorno y su clave pública coincide", async () => {
    const pub = (await hqApp.inject({ method: "GET", url: "/api/hq/public-key" })).json()
      .public_key;
    expect(pub).toBe(KEYS.publicKey);
  });
});
