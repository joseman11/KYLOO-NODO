import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Browser,
  type Nodo,
  adminSession,
  hasText,
  launch,
  newPage,
  settle,
  sleep,
  startNodo,
  tap,
  until,
  waitText,
} from "./harness";

/** Impresoras de red: cajón de dinero, prueba de impresión y búsqueda en la red, desde la interfaz. */
let nodo: Nodo;
let browser: Browser;
let admin: Awaited<ReturnType<typeof newPage>>;
beforeAll(async () => {
  nodo = await startNodo();
  browser = await launch();
  admin = await newPage(browser, nodo.url);
  await adminSession(admin.page, nodo.url);
});
afterAll(async () => {
  await admin?.ctx.close();
  await browser?.close();
  await nodo?.close();
});

const PULSE = "\x1bp\x00\x19\xfa";
const goPrinters = async () => {
  await tap(admin.page, "Config", ".rail-btn");
  await tap(admin.page, "Impresoras", ".view > .row.wrap > .chip");
  await settle(admin.page);
};

describe("impresoras", () => {
  it("la prueba de impresión sale por la impresora y se avisa en pantalla", async () => {
    await goPrinters();
    const before = nodo.transport.sent.length;
    await tap(admin.page, "Probar", "button");
    await until(
      async () => (await hasText(admin.page, "se imprimió")) || null,
      "resultado de la prueba",
    );
    expect(nodo.transport.sent.length).toBe(before + 1);
  });

  it("se activa el cajón en la impresora de caja y se abre a mano desde Caja", async () => {
    await goPrinters();
    // la demo trae la impresora de caja; se marca que tiene cajón
    const cashPrinters = (await nodo.db
      .prepare("SELECT id FROM printers WHERE kind='caja'")
      .all()) as { id: string }[];
    expect(cashPrinters.length).toBeGreaterThan(0);
    await tap(admin.page, "Cajón: no", "button");
    await waitText(admin.page, "Cajón: sí");
    const flag = (await nodo.db
      .prepare("SELECT COUNT(*) c FROM printers WHERE kind='caja' AND has_drawer=1")
      .get()) as { c: number };
    expect(flag.c).toBeGreaterThan(0);

    // en Caja aparece el botón y abre el cajón por la cola
    await tap(admin.page, "Caja", ".rail-btn");
    await until(async () => (await hasText(admin.page, "Abrir cajón")) || null, "botón del cajón");
    nodo.transport.sent.length = 0;
    await tap(admin.page, "Abrir cajón", "button");
    await until(
      async () => nodo.transport.sent.some((s) => s.text.includes(PULSE)) || null,
      "pulso del cajón",
    );
  });

  it("busca impresoras en la red y agrega la encontrada", async () => {
    // Un «impresora» de mentira escucha en 9100 de todas las interfaces; el escaneo de las redes del equipo la encuentra
    const server = net.createServer((c) => c.end());
    const listening = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(9100, "0.0.0.0", () => resolve(true));
    });
    if (!listening) return; // el puerto 9100 está ocupado en este equipo: no se puede simular
    try {
      await goPrinters();
      await tap(admin.page, "Buscar en la red", "button");
      // sin red local (solo loopback) no hay nada que encontrar: la pantalla debe decirlo en vez de quedarse esperando
      await until(
        async () =>
          (await hasText(admin.page, "Agregar")) ||
          (await hasText(admin.page, "No se encontró ninguna")) ||
          null,
        "resultado de la búsqueda",
        60_000,
      );
      if (await hasText(admin.page, "No se encontró ninguna")) return;
      const before = (await nodo.db.prepare("SELECT COUNT(*) c FROM printers").get()) as {
        c: number;
      };
      await tap(admin.page, "Agregar", ".sheet button");
      await sleep(500);
      await until(async () => {
        const n = (await nodo.db.prepare("SELECT COUNT(*) c FROM printers").get()) as { c: number };
        return n.c === before.c + 1 || null;
      }, "impresora agregada");
    } finally {
      server.close();
    }
  });
});
