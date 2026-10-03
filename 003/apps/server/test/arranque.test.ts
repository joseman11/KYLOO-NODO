import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appVersion, defaultDataDir, loadConfig } from "../src/config";
import { migrate, openDb } from "../src/db";
import { Logger, RotatingLog, fastifyLoggerOptions } from "../src/logging";
import { buildApp } from "../src/app";
import { Hub } from "../src/hub";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nodo-arranque-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("configuración", () => {
  it("sin variables mantiene data/ junto a donde se arranca (desarrollo)", () => {
    const c = loadConfig({}, "/work/server");
    expect(c.dataDir).toBe("/work/server/data");
    expect(c.dbFile).toBe("/work/server/data/003.sqlite");
    expect(c.port).toBe(3003);
    expect(c.role).toBe("local");
  });

  it("con NODO_DATA_DIR todo vive dentro de esa carpeta", () => {
    const c = loadConfig({ NODO_DATA_DIR: "/var/lib/nodo" }, "/x");
    expect(c.dbFile).toBe("/var/lib/nodo/nodo.sqlite");
    expect(c.backupDir).toBe("/var/lib/nodo/backups");
    expect(c.photosDir).toBe("/var/lib/nodo/photos");
    expect(c.logDir).toBe("/var/lib/nodo/logs");
  });

  it("las variables sueltas anteriores siguen mandando", () => {
    const c = loadConfig({ NODO_DATA_DIR: "/d", DB_FILE: "/otra/base.sqlite", PORT: "4000" }, "/x");
    expect(c.dbFile).toBe("/otra/base.sqlite");
    expect(c.port).toBe(4000);
  });

  it("DB_FILE sola arrastra la carpeta de datos (respaldos y fotos junto a la base)", () => {
    const c = loadConfig({ DB_FILE: "/datos/mia.sqlite" }, "/x");
    expect(c.dataDir).toBe("/datos");
    expect(c.backupDir).toBe("/datos/backups");
  });

  it("la carpeta de datos por defecto de cada sistema nunca está junto al programa", () => {
    expect(defaultDataDir("win32", { ProgramData: "D:\\PD" })).toMatch(/Nodo$/);
    expect(defaultDataDir("darwin", { HOME: "/Users/a" })).toBe(
      "/Users/a/Library/Application Support/Nodo",
    );
    expect(defaultDataDir("linux", {})).toBe("/var/lib/nodo");
  });

  it("la versión la fija el empaquetado o sale del package.json", () => {
    expect(appVersion({ NODO_VERSION: "1.2.3" })).toBe("1.2.3");
    expect(appVersion({})).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("registros", () => {
  it("rota por tamaño y conserva solo los archivos indicados", () => {
    const log = new RotatingLog({ dir: tmp, name: "t", maxBytes: 50, keep: 3 });
    for (let i = 0; i < 12; i++) log.write(`línea número ${i} con relleno\n`);
    const files = readdirSync(tmp).sort();
    expect(files).toEqual(["t.log", "t.log.1", "t.log.2"]);
    // lo más reciente está en el archivo activo
    expect(readFileSync(join(tmp, "t.log"), "utf8")).toContain("número 11");
  });

  it("al reabrir continúa el archivo existente en vez de pisarlo", () => {
    new RotatingLog({ dir: tmp, name: "t" }).write("uno\n");
    new RotatingLog({ dir: tmp, name: "t" }).write("dos\n");
    expect(readFileSync(join(tmp, "t.log"), "utf8")).toBe("uno\ndos\n");
  });

  it("el registrador del ciclo de vida respeta el nivel y escribe JSON", () => {
    const out: string[] = [];
    const log = new Logger({ write: (s) => out.push(s) }, "warn");
    log.info("no sale");
    log.warn("sí sale", { a: 1 });
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ level: 40, msg: "sí sale", a: 1 });
  });

  it("la URL registrada no lleva el token del WebSocket", () => {
    const { serializers } = fastifyLoggerOptions({ write() {} }, "warn");
    expect(serializers.req({ method: "GET", url: "/ws?token=eyJsecreto" })).toEqual({
      method: "GET",
      url: "/ws",
    });
  });

  it("un error 500 queda en el archivo y la petición normal no deja rastro", async () => {
    const lines: string[] = [];
    const db = await openDb(":memory:");
    const app = buildApp(db, {
      hub: new Hub(),
      logger: { stream: { write: (s) => lines.push(s) }, level: "warn" },
    });
    app.get("/api/boom", async () => {
      throw new Error("fallo de prueba");
    });
    await app.inject({ method: "GET", url: "/api/health" });
    expect(lines).toHaveLength(0);
    const r = await app.inject({ method: "GET", url: "/api/boom?token=secreto" });
    expect(r.statusCode).toBe(500);
    const text = lines.join("");
    expect(text).toContain("fallo de prueba");
    expect(text).not.toContain("secreto");
    await app.close();
  });
});

describe("salud", () => {
  it("publica versión, motor y tiempo en marcha", async () => {
    const db = await openDb(":memory:");
    const app = buildApp(db, { hub: new Hub(), version: "9.9.9" });
    const body = (await app.inject({ method: "GET", url: "/api/health" })).json();
    expect(body).toMatchObject({ ok: true, version: "9.9.9" });
    expect(["sqlite", "pg"]).toContain(body.engine);
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
    await app.close();
  });
});

describe("copia antes de migrar", () => {
  const m1 = {
    id: 1,
    name: "uno",
    sql: "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE a (x INTEGER)",
  };
  const m2 = { id: 2, name: "dos", sql: "CREATE TABLE b (y INTEGER)" };

  it("una base nueva no genera copia", async () => {
    const calls: number[][] = [];
    const db = await openDb(join(tmp, "n.sqlite"), {
      migrations: [m1],
      backupDir: join(tmp, "bk"),
      onPreMigrationBackup: (_f, p) => calls.push(p),
    });
    await db.close();
    expect(calls).toEqual([]);
    expect(existsSync(join(tmp, "bk"))).toBe(false);
  });

  it("con migraciones pendientes sobre datos, copia la base antes de aplicarlas", async () => {
    const file = join(tmp, "d.sqlite");
    const first = await openDb(file, { migrations: [m1] });
    await first.exec("INSERT INTO a (x) VALUES (42)");
    await first.close();

    const copies: string[] = [];
    const second = await openDb(file, {
      migrations: [m1, m2],
      backupDir: join(tmp, "bk"),
      onPreMigrationBackup: (f) => copies.push(f),
    });
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/pre-migracion-1-a-2\.sqlite$/);
    // la copia es la base anterior: tiene los datos y todavía no la tabla nueva
    const copy = await openDb(copies[0]!, { migrations: [m1] });
    expect(await copy.prepare("SELECT x FROM a").get()).toMatchObject({ x: 42 });
    expect(
      await copy.prepare("SELECT name FROM sqlite_master WHERE name='b'").get(),
    ).toBeUndefined();
    await copy.close();
    // y la base real ya está migrada
    expect(
      await second.prepare("SELECT name FROM sqlite_master WHERE name='b'").get(),
    ).toBeTruthy();
    await second.close();
  });

  it("si la migración falla, la copia previa existe y los datos siguen en la base", async () => {
    const file = join(tmp, "f.sqlite");
    const first = await openDb(file, { migrations: [m1] });
    await first.exec("INSERT INTO a (x) VALUES (7)");
    await first.close();
    const bad = { id: 2, name: "rota", sql: "CREATE TABLE a (y INTEGER)" };
    await expect(
      openDb(file, { migrations: [m1, bad], backupDir: join(tmp, "bk") }),
    ).rejects.toThrow();
    expect(readdirSync(join(tmp, "bk"))).toEqual(["pre-migracion-1-a-2.sqlite"]);
    const again = await openDb(file, { migrations: [m1] });
    expect(await again.prepare("SELECT x FROM a").get()).toMatchObject({ x: 7 });
    await again.close();
  });

  it("migrate sigue siendo idempotente", async () => {
    const db = await openDb(":memory:");
    await migrate(db);
    await migrate(db);
  });
});
