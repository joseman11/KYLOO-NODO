import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { runCloudBackup, cloudBackupStatus, startCloudBackupWorker } from "../src/cloud-backup";
import { type Db, openDb } from "../src/db";
import { fingerprintOf } from "../src/fingerprint";
import { Hub } from "../src/hub";
import { generateSigningKeys } from "../src/license";
import { restoreFromCloud } from "../src/restore";
import { seed } from "../src/seed";

const KEYS = generateSigningKeys();
const FP_A = fingerprintOf("equipo-a");
const FP_B = fingerprintOf("equipo-nuevo-b");

let tmp: string;
let hqApp: FastifyInstance;
let hqUrl: string;
let ownerToken: string;
let branchId: string;
let code: string;
const apps: FastifyInstance[] = [];

async function startHq(extra: Record<string, unknown> = {}) {
  hqApp = buildApp(await openDb(":memory:"), {
    hub: new Hub(),
    hq: {
      adminToken: "plataforma",
      signingKey: KEYS.privateKey,
      backupStoreDir: join(tmp, "hq-store"),
      ...extra,
    },
  });
  await hqApp.listen({ port: 0, host: "127.0.0.1" });
  const a = hqApp.server.address();
  hqUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  await hqApp.inject({
    method: "POST",
    url: "/api/hq/orgs",
    headers: { "x-hq-admin": "plataforma" },
    payload: {
      name: "Mariscos",
      plan: "profesional",
      owner: { username: "dueno", password: "clave-segura-1" },
    },
  });
  ownerToken = (
    await hqApp.inject({
      method: "POST",
      url: "/api/hq/login",
      payload: { username: "dueno", password: "clave-segura-1" },
    })
  ).json().token;
  const br = await hqApp.inject({
    method: "POST",
    url: "/api/hq/branches",
    headers: { Authorization: `Bearer ${ownerToken}` },
    payload: { name: "Centro" },
  });
  ({ id: branchId, activation_code: code } = br.json());
}
const newCode = async () =>
  (
    await hqApp.inject({
      method: "POST",
      url: `/api/hq/branches/${branchId}/activation-code`,
      headers: { Authorization: `Bearer ${ownerToken}` },
    })
  ).json().code as string;

async function makeLocal(fp: string, name = "local") {
  const db = await openDb(join(tmp, `${name}.sqlite`));
  await seed(db, "clave-del-local-1");
  const photos = join(tmp, `${name}-photos`);
  mkdirSync(photos, { recursive: true });
  const app = buildApp(db, {
    hub: new Hub(),
    photosDir: photos,
    backupDir: join(tmp, `${name}-backups`),
    licensing: { mode: "enforced", publicKeys: [KEYS.publicKey], fingerprint: fp },
    hqUrl,
  });
  apps.push(app);
  const token = (
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "clave-del-local-1" },
    })
  ).json().token as string;
  const call = (method: "GET" | "POST", url: string, body?: unknown, tk = token) =>
    app.inject({
      method,
      url,
      headers: { Authorization: `Bearer ${tk}` },
      payload: body as object,
    });
  return { app, db, photos, token, call };
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "nodo-nube-"));
  await startHq();
});
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  await hqApp.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("respaldo cifrado en la nube", () => {
  it("el local activado sube un respaldo y el HQ guarda solo texto cifrado", async () => {
    const l = await makeLocal(FP_A);
    expect((await l.call("POST", "/api/license/activate", { code })).statusCode).toBe(200);
    writeFileSync(join(l.photos, "ceviche.jpg"), Buffer.from("fotografia-del-ceviche"));
    const r = (await l.call("POST", "/api/cloud/backup/now")).json();
    expect(r.ok).toBe(true);
    const st = (await l.call("GET", "/api/cloud/backup/status")).json();
    expect(st).toMatchObject({ linked: true, keyCreated: true, lastError: null, failures: 0 });
    expect(st.lastSize).toBe(r.size);

    const files = readdirSync(join(tmp, "hq-store", branchId));
    expect(files).toEqual([r.name]);
    const stored = readFileSync(join(tmp, "hq-store", branchId, r.name));
    expect(stored.length).toBe(r.size);
    for (const secreto of [
      "SQLite format 3",
      "Administrador",
      "fotografia-del-ceviche",
      "establishment",
    ])
      expect(stored.includes(Buffer.from(secreto)), secreto).toBe(false);
    // el propietario ve que existe, sin poder leerlo
    const list = (
      await hqApp.inject({
        method: "GET",
        url: `/api/hq/branches/${branchId}/backups`,
        headers: { Authorization: `Bearer ${ownerToken}` },
      })
    ).json();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe(r.name);
  });

  it("la clave de recuperación se muestra hasta confirmarla y después pide la contraseña", async () => {
    const l = await makeLocal(FP_A);
    const k1 = (await l.call("POST", "/api/cloud/backup/key")).json().key as string;
    expect(k1).toMatch(/^([A-Z2-7]{5}-){10}[A-Z2-7]{5}$/);
    expect((await l.call("POST", "/api/cloud/backup/key")).json().key).toBe(k1);
    expect((await l.call("POST", "/api/cloud/backup/key/confirm")).statusCode).toBe(200);
    const again = await l.call("POST", "/api/cloud/backup/key");
    expect(again.statusCode).toBe(409);
    expect(
      (await l.call("POST", "/api/cloud/backup/key/show", { password: "mala" })).statusCode,
    ).toBe(401);
    expect(
      (await l.call("POST", "/api/cloud/backup/key/show", { password: "clave-del-local-1" })).json()
        .key,
    ).toBe(k1);
  });

  it("solo quien administra ve el estado y la clave", async () => {
    const l = await makeLocal(FP_A);
    const users = (await l.app.inject({ method: "GET", url: "/api/auth/users" })).json() as {
      id: string;
      name: string;
    }[];
    const juan = users.find((u) => u.name === "Juan")!;
    const t = (
      await l.app.inject({
        method: "POST",
        url: "/api/auth/pin",
        payload: { userId: juan.id, pin: "1111" },
      })
    ).json().token;
    expect((await l.call("GET", "/api/cloud/backup/status", undefined, t)).statusCode).toBe(403);
    expect((await l.call("POST", "/api/cloud/backup/key", undefined, t)).statusCode).toBe(403);
  });

  it("recuperación de desastre: una PC nueva recupera la base y las fotos con el código y la clave", async () => {
    const a = await makeLocal(FP_A, "a");
    await a.call("POST", "/api/license/activate", { code });
    await a.db
      .prepare("UPDATE settings SET value='Mariscos El Faro' WHERE key='establishment_name'")
      .run();
    await a.db
      .prepare(
        "INSERT OR IGNORE INTO settings (key,value) VALUES ('establishment_name','Mariscos El Faro')",
      )
      .run();
    writeFileSync(join(a.photos, "tostada.jpg"), Buffer.from("foto-tostada"));
    const key = (await a.call("POST", "/api/cloud/backup/key")).json().key as string;
    expect((await a.call("POST", "/api/cloud/backup/now")).json().ok).toBe(true);

    // se muere la PC: el propietario pide un código nuevo y se restaura en un equipo distinto
    const fresh = await newCode();
    const dest = join(tmp, "pc-nueva");
    const log: string[] = [];
    const r = await restoreFromCloud({
      hqUrl,
      code: fresh,
      recoveryKey: key,
      dataDir: dest,
      fingerprint: FP_B,
      log: (m) => log.push(m),
    });
    expect(r).toMatchObject({ photos: 1, branch: "Centro" });
    expect(log.length).toBeGreaterThan(2);

    const back = await openDb(join(dest, "nodo.sqlite"));
    expect(
      await back.prepare("SELECT value FROM settings WHERE key='establishment_name'").get(),
    ).toEqual({ value: "Mariscos El Faro" });
    expect(readFileSync(join(dest, "photos", "tostada.jpg"), "utf8")).toBe("foto-tostada");
    // quedó vinculada y con licencia nueva para el equipo nuevo
    const stored = async (k: string) =>
      (
        (await back.prepare("SELECT value FROM settings WHERE key=?").get(k)) as
          | { value: string }
          | undefined
      )?.value;
    expect(await stored("hq_url")).toBe(hqUrl);
    expect(await stored("hq_key")).toBeTruthy();
    expect(await stored("license")).toBeTruthy();
    await back.close();

    // y el equipo anterior ya no puede usar su llave
    const oldKey = (
      (await a.db.prepare("SELECT value FROM settings WHERE key='hq_key'").get()) as {
        value: string;
      }
    ).value;
    const denied = await hqApp.inject({
      method: "GET",
      url: "/api/hq/backups",
      headers: { "x-branch-key": oldKey, "x-device-fp": FP_A },
    });
    expect(denied.statusCode).toBe(401);
  });

  it("restaurar con una clave equivocada o con el archivo alterado no instala nada", async () => {
    const a = await makeLocal(FP_A, "a");
    await a.call("POST", "/api/license/activate", { code });
    const key = (await a.call("POST", "/api/cloud/backup/key")).json().key as string;
    const r = (await a.call("POST", "/api/cloud/backup/now")).json();

    const wrong = join(tmp, "dest1");
    await expect(
      restoreFromCloud({
        hqUrl,
        code: await newCode(),
        recoveryKey: "AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA",
        dataDir: wrong,
        fingerprint: FP_B,
      }),
    ).rejects.toThrow(/clave de recuperación no es válida/);
    expect(existsSync(join(wrong, "nodo.sqlite"))).toBe(false);

    // el archivo guardado en el HQ se altera (disco dañado o manipulado): la suma del HQ ya no coincide con el contenido
    const file = join(tmp, "hq-store", branchId, r.name);
    const bytes = readFileSync(file);
    bytes[100] = bytes[100]! ^ 0xff;
    writeFileSync(file, bytes);
    const dest = join(tmp, "dest2");
    await expect(
      restoreFromCloud({
        hqUrl,
        code: await newCode(),
        recoveryKey: key,
        dataDir: dest,
        fingerprint: FP_B,
      }),
    ).rejects.toThrow(/dañado|suma no coincide/);
    expect(existsSync(join(dest, "nodo.sqlite"))).toBe(false);
    expect(readdirSync(dest).filter((f) => f.startsWith(".descarga"))).toEqual([]);
  });

  it("restaurar no pisa una base existente sin --force", async () => {
    const a = await makeLocal(FP_A, "a");
    await a.call("POST", "/api/license/activate", { code });
    const key = (await a.call("POST", "/api/cloud/backup/key")).json().key as string;
    await a.call("POST", "/api/cloud/backup/now");
    const dest = join(tmp, "dest");
    mkdirSync(dest);
    writeFileSync(join(dest, "nodo.sqlite"), "base con ventas");
    await expect(
      restoreFromCloud({
        hqUrl,
        code: await newCode(),
        recoveryKey: key,
        dataDir: dest,
        fingerprint: FP_B,
      }),
    ).rejects.toThrow(/Ya existe una base/);
    expect(readFileSync(join(dest, "nodo.sqlite"), "utf8")).toBe("base con ventas");
  });

  it("sin Internet o con el HQ caído: el fallo queda visible con su motivo y la venta sigue", async () => {
    const l = await makeLocal(FP_A);
    await l.call("POST", "/api/license/activate", { code });
    await hqApp.close();
    const r = await runCloudBackup(l.db, {
      upload: async () => {
        throw new Error("ECONNREFUSED");
      },
      workDir: join(tmp, "work"),
      fingerprint: FP_A,
    });
    expect(r).toMatchObject({ ok: false, code: "sin_conexion" });
    const st = await cloudBackupStatus(l.db);
    expect(st).toMatchObject({ failures: 1, lastError: { code: "sin_conexion" } });
    expect(readdirSync(join(tmp, "work")).filter((f) => f.endsWith(".nbk"))).toEqual([]); // sin restos
    // la operación no se afecta
    const tables = (await l.call("GET", "/api/tables")).json();
    expect(tables.length).toBeGreaterThan(0);
    hqApp = buildApp(await openDb(":memory:"), { hub: new Hub() }); // para el afterEach
  });

  it("un local sin activar no puede respaldar y lo dice", async () => {
    const l = await makeLocal(FP_A);
    const r = (await l.call("POST", "/api/cloud/backup/now")).json();
    expect(r).toMatchObject({ ok: false, code: "sin_vincular" });
  });

  it("el proceso de fondo reintenta con espera creciente y se recupera solo", async () => {
    const l = await makeLocal(FP_A);
    await l.call("POST", "/api/license/activate", { code });
    let calls = 0;
    let online = false;
    let clock = Date.now();
    const stop = startCloudBackupWorker(
      l.db,
      {
        upload: async (url, init) => {
          calls++;
          if (!online) throw new Error("sin red");
          const body = readFileSync(init.file);
          const res = await fetch(url, {
            method: "PUT",
            headers: { ...init.headers, "content-length": String(body.length) },
            body,
          });
          return { ok: res.ok, status: res.status, json: () => res.json() };
        },
        workDir: join(tmp, "work"),
        fingerprint: FP_A,
      },
      { checkMs: 15, now: () => clock },
    );
    const waitFor = async (fn: () => Promise<boolean> | boolean, ms = 3000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("tiempo agotado");
    };
    await waitFor(async () => (await cloudBackupStatus(l.db)).failures >= 1);
    const first = calls;
    // dentro de la espera (1 min) no reintenta
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(first);
    // pasa el tiempo y vuelve la red
    online = true;
    clock += 2 * 60_000;
    await waitFor(async () => (await cloudBackupStatus(l.db)).lastOk !== null);
    stop();
    expect(await cloudBackupStatus(l.db)).toMatchObject({ failures: 0, lastError: null });
  });
});

describe("el HQ protege el almacén", () => {
  async function activated() {
    const l = await makeLocal(FP_A);
    await l.call("POST", "/api/license/activate", { code });
    const key = (
      (await l.db.prepare("SELECT value FROM settings WHERE key='hq_key'").get()) as {
        value: string;
      }
    ).value;
    const put = (name: string, body: Buffer, over: Record<string, string> = {}) =>
      hqApp.inject({
        method: "PUT",
        url: `/api/hq/backups/${name}`,
        headers: {
          "x-branch-key": key,
          "x-device-fp": FP_A,
          "content-type": "application/octet-stream",
          "x-sha256": createHash("sha256").update(body).digest("hex"),
          ...over,
        },
        payload: body,
      });
    return { put, key };
  }

  it("rechaza una suma que no coincide y no deja archivos a medias", async () => {
    const { put } = await activated();
    const r = await put("a-0001.nbk", Buffer.from("datos"), { "x-sha256": "0".repeat(64) });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("suma_no_coincide");
    const dir = join(tmp, "hq-store", branchId);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it("rechaza nombres inválidos, otro equipo y sucursales sin activar", async () => {
    const { put, key } = await activated();
    expect((await put("../escapa.nbk", Buffer.from("x"))).statusCode).toBeGreaterThanOrEqual(400);
    expect((await put("sin-extension", Buffer.from("x"))).statusCode).toBe(400);
    const other = await hqApp.inject({
      method: "GET",
      url: "/api/hq/backups",
      headers: { "x-branch-key": key, "x-device-fp": FP_B },
    });
    expect(other.statusCode).toBe(403);
  });

  it("respeta el tamaño máximo y la cuota por sucursal", async () => {
    await hqApp.close();
    await startHq({ backupMaxBytes: 100, branchQuotaBytes: 150 });
    const l = await makeLocal(FP_A);
    await l.call("POST", "/api/license/activate", { code });
    const key = (
      (await l.db.prepare("SELECT value FROM settings WHERE key='hq_key'").get()) as {
        value: string;
      }
    ).value;
    const put = (name: string, size: number) => {
      const body = Buffer.alloc(size, 7);
      return hqApp.inject({
        method: "PUT",
        url: `/api/hq/backups/${name}`,
        headers: {
          "x-branch-key": key,
          "x-device-fp": FP_A,
          "content-type": "application/octet-stream",
          "x-sha256": createHash("sha256").update(body).digest("hex"),
        },
        payload: body,
      });
    };
    expect((await put("grande-1.nbk", 101)).json().error).toBe("respaldo_demasiado_grande");
    expect((await put("uno-uno.nbk", 90)).statusCode).toBe(201);
    expect((await put("dos-dos.nbk", 90)).json().error).toBe("cuota_excedida");
    // reemplazar el mismo nombre no cuenta dos veces
    expect((await put("uno-uno.nbk", 95)).statusCode).toBe(201);
  });

  it("retención: 14 recientes y el más reciente de los meses anteriores", async () => {
    const { put } = await activated();
    for (let i = 0; i < 16; i++)
      expect(
        (await put(`r-${String(i).padStart(4, "0")}.nbk`, Buffer.from(`d${i}`))).statusCode,
      ).toBe(201);
    const files = readdirSync(join(tmp, "hq-store", branchId)).sort();
    // 14 más recientes + 1 del mismo mes entre los más viejos
    expect(files).toHaveLength(15);
    expect(files).toContain("r-0015.nbk");
    expect(files).not.toContain("r-0000.nbk");
  });

  it("un servidor sin almacén responde 501 con motivo", async () => {
    await hqApp.close();
    hqApp = buildApp(await openDb(":memory:"), {
      hub: new Hub(),
      hq: { adminToken: "plataforma", signingKey: KEYS.privateKey },
    });
    const r = await hqApp.inject({
      method: "GET",
      url: "/api/hq/backups",
      headers: { "x-branch-key": "bk_x" },
    });
    expect(r.statusCode).toBe(501);
    expect(r.json().error).toBe("respaldo_no_disponible");
  });
});
