import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Browser,
  type Nodo,
  type Page,
  hasText,
  launch,
  newPage,
  rectOf,
  sessionFor,
  settle,
  sleep,
  startNodo,
  tap,
  until,
  waitText,
} from "./harness";

/**
 * Una tablet pierde la red local a mitad del servicio: abre una mesa y toma la comanda sin conexión, y al reconectar todo
 * llega al servidor una sola vez y en orden (mesa primero, comanda después).
 */
let nodo: Nodo;
let browser: Browser;
let waiter: Awaited<ReturnType<typeof newPage>>;
let offline = false;

beforeAll(async () => {
  nodo = await startNodo();
  browser = await launch();
  waiter = await newPage(browser, nodo.url);
  await sessionFor(waiter.page, nodo.url, "Juan", "1111");
  // «Sin red»: las peticiones al servidor fallan como si el WiFi se hubiera caído (el WebSocket se corta aparte)
  await waiter.page.setRequestInterception(true);
  waiter.page.on("request", (req) => {
    if (offline && new URL(req.url()).pathname.startsWith("/api"))
      req.abort("internetdisconnected");
    else req.continue();
  });
});
afterAll(async () => {
  await browser?.close();
  await nodo?.close();
});

const one = async <T>(sql: string, ...a: unknown[]) => (await nodo.db.prepare(sql).get(...a)) as T;

async function tapPaged(page: Page, text: string, sel: string) {
  for (let i = 0; i < 4; i++) {
    const r = await rectOf(page, text, sel);
    if (r) {
      await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2);
      await sleep(150);
      return;
    }
    const next = await rectOf(page, "›", ".pager button");
    if (!next) break;
    await page.mouse.click(next.x + next.w / 2, next.y + next.h / 2);
    await sleep(300);
  }
  throw new Error(`No se encontró «${text}»`);
}

/** Corta el WebSocket desde el servidor: al volver a abrirse, la tablet sincroniza lo pendiente. */
const dropSockets = () => {
  const wss = (nodo.app as unknown as { websocketServer: { clients: Set<{ terminate(): void }> } })
    .websocketServer;
  for (const c of wss.clients) c.terminate();
};

describe("mesa y comanda sin conexión", () => {
  it("con la red caída, la tablet abre la mesa y toma la comanda", async () => {
    const p = waiter.page;
    await settle(p);
    // la tablet ya conoce el mapa y el menú: se carga el comandero una vez con red para que quede en caché
    await tapPaged(p, "T3", ".table-card");
    await waitText(p, "¿Cuántas personas?");
    await tap(p, "Cancelar", "button").catch(() => undefined);
    await p.reload({ waitUntil: "networkidle0" });
    await settle(p);

    offline = true;
    await tapPaged(p, "T3", ".table-card");
    await waitText(p, "¿Cuántas personas?");
    await tap(p, "2", ".numpad button, button");
    await tap(p, "Abrir mesa", "button");
    await waitText(p, "Mesa T3"); // entró al comandero con la cuenta provisional
    // todavía no existe ninguna cuenta abierta de esa mesa en el servidor
    expect(
      await one<{ c: number }>(
        "SELECT COUNT(*) c FROM accounts a JOIN tables_ t ON t.id=a.table_id WHERE t.number='T3' AND a.status!='cerrada'",
      ),
    ).toEqual({ c: 0 });

    await tap(p, "Entradas", ".opt");
    await tap(p, "Ceviche mixto", ".product");
    await until(async () => (await p.$(".sheet")) || null, "ventana de personalización");
    await tap(p, "Agregar", ".sheet button");
    await until(async () => !(await p.$(".sheet")) || null, "cierre");
    await tap(p, "Enviar comanda", "button");
    await waitText(p, "Sin conexión: comanda guardada");
    // la comanda enviada se ve en la cuenta, marcada como pendiente
    await until(async () => (await hasText(p, "sin sincronizar")) || null, "renglón pendiente");
  });

  it("sobrevive a recargar la página: lo pendiente no se pierde", async () => {
    const stored = await waiter.page.evaluate(() =>
      JSON.parse(localStorage.getItem("003.pending-ops") ?? "[]"),
    );
    expect(stored.map((o: { type: string }) => o.type)).toEqual(["open_table", "order"]);
    expect(stored[1].accountRef).toBe(stored[0].id);
  });

  it("al volver la red, la mesa se abre y la comanda llega una sola vez, a su cuenta", async () => {
    const before = await one<{ c: number }>("SELECT COUNT(*) c FROM orders");
    offline = false;
    dropSockets();
    await until(
      async () => {
        const n = await one<{ c: number }>(
          "SELECT COUNT(*) c FROM accounts a JOIN tables_ t ON t.id=a.table_id WHERE t.number='T3' AND a.status!='cerrada'",
        );
        return n.c === 1 || null;
      },
      "la mesa abierta en el servidor",
      20_000,
    );
    await until(
      async () =>
        (await one<{ c: number }>("SELECT COUNT(*) c FROM orders")).c === before.c + 1 || null,
      "la comanda en el servidor",
      20_000,
    );
    const rows = (await nodo.db
      .prepare(
        "SELECT oi.quantity, p.name FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id JOIN accounts a ON a.id=o.account_id JOIN tables_ t ON t.id=a.table_id WHERE t.number='T3' AND a.status!='cerrada'",
      )
      .all()) as { name: string; quantity: number }[];
    expect(rows).toEqual([{ name: "Ceviche mixto", quantity: 1 }]);
    // la cola queda vacía y la pantalla ya habla de la cuenta real
    await until(
      async () =>
        (await waiter.page.evaluate(() => localStorage.getItem("003.pending-ops"))) === "[]" ||
        null,
      "cola vacía",
    );
    await until(
      async () => !(await hasText(waiter.page, "sin sincronizar")) || null,
      "sin pendientes en pantalla",
    );
    // reenviar no duplica (clave idempotente)
    dropSockets();
    await sleep(2500);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM orders")).c).toBe(before.c + 1);
  });

  it("si otra tablet ocupó la mesa mientras tanto, se avisa y no se duplica nada", async () => {
    const p = waiter.page;
    // Juan vuelve al mapa
    await tap(p, "Mesas", ".rail-btn");
    await settle(p);
    offline = true;
    await tapPaged(p, "T5", ".table-card");
    await waitText(p, "¿Cuántas personas?");
    await tap(p, "2", ".numpad button, button");
    await tap(p, "Abrir mesa", "button");
    await waitText(p, "Mesa T5");
    // mientras esta tablet no tenía red, otra ocupó T5
    const caja = await nodo.app.inject({ method: "GET", url: "/api/auth/users" });
    const lucia = (caja.json() as { id: string; name: string }[]).find((u) => u.name === "Lucía")!;
    const tk = (
      await nodo.app.inject({
        method: "POST",
        url: "/api/auth/pin",
        payload: { userId: lucia.id, pin: "4444" },
      })
    ).json().token;
    const tables = (
      await nodo.app.inject({
        method: "GET",
        url: "/api/tables",
        headers: { Authorization: `Bearer ${tk}` },
      })
    ).json() as { id: string; number: string }[];
    const t5 = tables.find((t) => t.number === "T5")!;
    const r = await nodo.app.inject({
      method: "POST",
      url: `/api/tables/${t5.id}/open`,
      headers: { Authorization: `Bearer ${tk}` },
      payload: { guests: 3 },
    });
    expect(r.statusCode).toBe(201);
    offline = false;
    dropSockets();
    // aparece el aviso y la tablet vuelve al mapa; solo existe la cuenta de Lucía
    await until(
      async () => (await hasText(p, "No se pudo abrir la mesa")) || null,
      "aviso de conflicto",
      20_000,
    );
    const n = await one<{ c: number }>(
      "SELECT COUNT(*) c FROM accounts a JOIN tables_ t ON t.id=a.table_id WHERE t.number='T5' AND a.status!='cerrada'",
    );
    expect(n.c).toBe(1);
    const real = waiter.problems.filter(
      (x) => !/internetdisconnected|requestfailed|Failed to fetch/i.test(x),
    );
    expect(real, real.join(" | ")).toEqual([]);
  });
});
