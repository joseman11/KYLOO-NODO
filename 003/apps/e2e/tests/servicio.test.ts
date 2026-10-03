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
  sleep,
  startNodo,
  tap,
  until,
  waitText,
  selectAll,
} from "./harness";

/**
 * Servicio completo a través de la interfaz, con clics reales:
 * mesero toma el pedido → cocina lo prepara → mesero entrega → junta mesas → caja cobra.
 * Cada paso se confirma contra la base de datos, no solo contra lo que se ve.
 */
let nodo: Nodo;
let browser: Browser;
beforeAll(async () => {
  nodo = await startNodo();
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
  await nodo?.close();
});

const one = async <T>(sql: string, ...a: unknown[]) => (await nodo.db.prepare(sql).get(...a)) as T;
const all = async <T>(sql: string, ...a: unknown[]) =>
  (await nodo.db.prepare(sql).all(...a)) as T[];

/** Toca un elemento que puede estar en otra página del paginador: avanza hasta encontrarlo. */
async function tapPaged(page: Page, text: string, sel?: string) {
  for (let i = 0; i < 4; i++) {
    const r = await rectOf(page, text, sel);
    if (r) {
      await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2);
      await sleep(150);
      return;
    }
    const next = await rectOf(
      page,
      "›",
      sel?.startsWith(".sheet") ? ".sheet .pager button" : ".pager button",
    );
    if (!next) break;
    await page.mouse.click(next.x + next.w / 2, next.y + next.h / 2);
    await sleep(300);
  }
  throw new Error(`No se encontró «${text}» en ninguna página`);
}

let waiter: Awaited<ReturnType<typeof newPage>>;
let accountId = "";

describe("1 · el mesero toma el pedido", () => {
  beforeAll(async () => {
    waiter = await newPage(browser, nodo.url);
    await sessionFor(waiter.page, nodo.url, "Juan", "1111");
  });

  it("abre una mesa libre con el teclado numérico", async () => {
    await tapPaged(waiter.page, "T3", ".table-card");
    await waitText(waiter.page, "¿Cuántas personas?");
    await tap(waiter.page, "4", ".numpad button, button");
    await tap(waiter.page, "Abrir mesa", "button");
    await waitText(waiter.page, "Mesa T3");
    const acc = await one<{ id: string; guests: number; waiter: string }>(
      "SELECT a.id, a.guests, u.name waiter FROM accounts a JOIN users u ON u.id=a.waiter_id JOIN tables_ t ON t.id=a.table_id WHERE t.number='T3' AND a.status!='cerrada'",
    );
    expect(acc.waiter).toBe("Juan");
    expect(acc.guests).toBeGreaterThanOrEqual(1);
    accountId = acc.id;
    expect(
      (await one<{ status: string }>("SELECT status FROM tables_ WHERE number='T3'")).status,
    ).toBe("ocupada");
  });

  it("agrega un platillo con extras desde la ventana de personalización", async () => {
    const p = waiter.page;
    await tap(p, "Entradas", ".opt");
    await tap(p, "Ceviche mixto", ".product");
    await until(async () => (await p.$(".sheet")) || null, "ventana de personalización");
    expect(await hasText(p, "Picante")).toBe(true);
    await tap(p, "Aguacate", ".sheet button");
    await tap(p, "Poco picante", ".sheet button");
    // el botón elegido queda marcado
    expect(
      await p.$$eval(".sheet .opt.on", (e) => e.map((x) => (x as HTMLElement).innerText.trim())),
    ).toEqual(expect.arrayContaining([expect.stringContaining("Aguacate"), "Poco picante"]));
    await tap(p, "Agregar", ".sheet button");
    await until(async () => !(await p.$(".sheet")) || null, "que se cierre la ventana");
    const row = await p.$$eval(".tk", (e) =>
      e.map((x) => (x as HTMLElement).innerText.replace(/\n+/g, " ")),
    );
    expect(
      row.some(
        (r) => r.includes("Ceviche mixto") && r.includes("Aguacate") && r.includes("Poco picante"),
      ),
    ).toBe(true);
    // el total sube con el extra ($175 + $25)
    expect(await hasText(p, "$200.00")).toBe(true);
  });

  it("agrega otro platillo y una bebida buscándola por nombre", async () => {
    const p = waiter.page;
    await tap(p, "Aguachile verde", ".product");
    await until(async () => (await p.$(".sheet")) || null, "ventana del aguachile");
    await tap(p, "Normal", ".sheet button");
    await tap(p, "Agregar", ".sheet button");
    await until(async () => !(await p.$(".sheet")) || null, "cierre");
    await tap(p, "Buscar", "input");
    await p.keyboard.type("Michel", { delay: 30 });
    await sleep(300);
    // el filtro deja solo lo que coincide
    const tiles = await p.$$eval(".product", (e) =>
      e.map((x) => (x as HTMLElement).innerText.split("\n")[0]),
    );
    expect(tiles).toEqual(["Michelada"]);
    await tap(p, "Michelada", ".product");
    await until(
      async () => (await p.$$eval(".tk", (e) => e.length)) >= 3 || null,
      "tres renglones",
    );
  });

  it("envía la comanda: queda guardada, producida por estación e impresa", async () => {
    const p = waiter.page;
    expect(await p.$eval(".btn.primary", (b) => (b as HTMLButtonElement).disabled)).toBe(false);
    await tap(p, "Enviar comanda", "button");
    await waitText(p, "Comanda enviada");
    const items = await all<{ name: string; modifiers: string; status: string }>(
      "SELECT name, modifiers, status FROM order_items WHERE account_id=? ORDER BY rowid",
      accountId,
    );
    expect(items.map((i) => i.name)).toEqual(["Ceviche mixto", "Aguachile verde", "Michelada"]);
    expect(JSON.parse(items[0]!.modifiers)).toEqual(
      expect.arrayContaining(["Aguacate", "Poco picante"]),
    );
    const tickets = await all<{ station: string }>(
      "SELECT s.name station FROM production_tickets t JOIN stations s ON s.id=t.station_id JOIN orders o ON o.id=t.order_id WHERE o.account_id=?",
      accountId,
    );
    expect(tickets.map((t) => t.station).sort()).toEqual(["Barra", "Cevichería"]);
    expect(
      (
        await one<{ c: number }>(
          "SELECT COUNT(*) c FROM print_jobs WHERE ticket_id IN (SELECT t.id FROM production_tickets t JOIN orders o ON o.id=t.order_id WHERE o.account_id=?)",
          accountId,
        )
      ).c,
    ).toBeGreaterThanOrEqual(2);
    // lo enviado ya no se puede mandar otra vez desde la pantalla
    expect(await p.$eval(".btn.primary", (b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });
});

describe("2 · la cocina lo recibe y lo marca", () => {
  it("la pantalla de la estación muestra el pedido en vivo y avanza Preparar → Listo", async () => {
    const chef = await newPage(browser, nodo.url);
    await sessionFor(chef.page, nodo.url, "Chef Ramón", "7777");
    await tap(chef.page, "Cocina", ".rail-btn");
    await tap(chef.page, "Cevichería", "button");
    await waitText(chef.page, "T3");
    expect(await hasText(chef.page, "Ceviche mixto")).toBe(true);
    expect(await hasText(chef.page, "Aguacate")).toBe(true);
    expect(await hasText(chef.page, "Michelada")).toBe(false); // la bebida es de la barra
    await tap(chef.page, "Preparar", ".ticket button");
    await waitText(chef.page, "Listo");
    expect(
      (
        await one<{ status: string }>(
          "SELECT t.status FROM production_tickets t JOIN stations s ON s.id=t.station_id JOIN orders o ON o.id=t.order_id WHERE o.account_id=? AND s.name='Cevichería'",
          accountId,
        )
      ).status,
    ).toBe("preparando");
    await tap(chef.page, "Listo", ".ticket button");
    await until(
      async () =>
        (
          await one<{ status: string }>(
            "SELECT t.status FROM production_tickets t JOIN stations s ON s.id=t.station_id JOIN orders o ON o.id=t.order_id WHERE o.account_id=? AND s.name='Cevichería'",
            accountId,
          )
        ).status === "listo" || null,
      "ticket listo",
    );
    expect(chef.problems, chef.problems.join(" | ")).toEqual([]);
    await chef.ctx.close();
  });

  it("el mesero ve el aviso en «Listos para entregar» y entrega", async () => {
    const p = waiter.page;
    await tap(p, "← Mesas", "button");
    await waitText(p, "Listos para entregar");
    const clicked = await until(async () => {
      const r = await p.evaluate(() => {
        const row = [...document.querySelectorAll("aside.pane tr")].find((x) =>
          (x as HTMLElement).innerText.trim().startsWith("Mesa T3"),
        );
        const b =
          row &&
          [...row.querySelectorAll("button")].find(
            (x) => (x as HTMLElement).innerText.trim() === "Entregar",
          );
        if (!b) {
          // la fila puede estar en otra página del panel: se pasa a la siguiente
          (
            document.querySelector("aside.pane .pager button:last-child") as HTMLElement | null
          )?.click();
          return null;
        }
        const rc = b.getBoundingClientRect();
        return { x: rc.x + rc.width / 2, y: rc.y + rc.height / 2 };
      });
      return r;
    }, "fila de T3 con Entregar");
    await p.mouse.click(clicked.x, clicked.y);
    await until(
      async () =>
        (
          await one<{ status: string }>(
            "SELECT t.status FROM production_tickets t JOIN stations s ON s.id=t.station_id JOIN orders o ON o.id=t.order_id WHERE o.account_id=? AND s.name='Cevichería'",
            accountId,
          )
        ).status === "entregado" || null,
      "entregado",
    );
  });
});

describe("3 · juntar mesas", () => {
  it("junta una mesa libre a la cuenta desde el comandero y el mapa lo refleja", async () => {
    const p = waiter.page;
    await tapPaged(p, "T3", ".table-card"); // la cuenta propia abre directo el comandero
    await waitText(p, "Mesa T3");
    await tap(p, "Juntar mesas", "button");
    await until(async () => (await p.$(".sheet")) || null, "selector de mesas");
    await tapPaged(p, "Mesa T7", ".sheet .opt");
    await until(async () => !(await p.$(".sheet")) || null, "cierre del selector");
    expect(
      (await one<{ c: number }>("SELECT COUNT(*) c FROM table_links WHERE account_id=?", accountId))
        .c,
    ).toBe(1);
    await tap(p, "← Mesas", "button");
    await until(
      async () =>
        (await rectOf(p, "T7", ".table-card")) || (await rectOf(p, "›", ".pager button")) || null,
      "mapa de mesas",
    );
    await tapPaged(p, "T7", ".table-card"); // la mesa unida muestra su panel
    await waitText(p, "Unida a la mesa T3");
  });

  it("separar la mesa la deja libre otra vez", async () => {
    const p = waiter.page;
    await tap(p, "Separar", "button");
    await until(
      async () => (await one<{ c: number }>("SELECT COUNT(*) c FROM table_links")).c === 0 || null,
      "enlace eliminado",
    );
    expect(
      (await one<{ status: string }>("SELECT status FROM tables_ WHERE number='T7'")).status,
    ).toBe("disponible");
  });
});

describe("4 · la caja cobra", () => {
  it("cobra en efectivo con cambio y la mesa queda libre", async () => {
    const caja = await newPage(browser, nodo.url);
    await sessionFor(caja.page, nodo.url, "Caja", "3333");
    const p = caja.page;
    const before = (await one<{ c: number }>("SELECT COUNT(*) c FROM payments")).c;
    await tapPaged(p, "T4", ".table-card");
    await tap(p, "Cobrar", "button");
    await until(async () => (await p.$(".sheet")) || null, "ventana de cobro");
    expect(await hasText(p, "Cuenta completa")).toBe(true);
    await tap(p, "Monto", "input");
    await selectAll(p);
    await p.keyboard.type("2000", { delay: 30 });
    await sleep(300);
    expect(await hasText(p, "Cobrar $1,035.00")).toBe(true);
    await tap(p, "Cobrar $", ".sheet button");
    await waitText(p, "Cobrado");
    await waitText(p, "Cambio");
    const pay = await one<{ total_cents: number; change_cents: number }>(
      "SELECT p.total_cents, p.change_cents FROM payments p JOIN accounts a ON a.id=p.account_id JOIN tables_ t ON t.id=a.table_id WHERE t.number='T4' ORDER BY p.created_at DESC LIMIT 1",
    );
    expect(pay.total_cents).toBe(103500);
    expect(pay.change_cents).toBe(96500);
    expect((await one<{ c: number }>("SELECT COUNT(*) c FROM payments")).c).toBe(before + 1);
    expect(
      (
        await one<{ status: string }>(
          "SELECT a.status FROM accounts a JOIN tables_ t ON t.id=a.table_id WHERE t.number='T4' ORDER BY a.opened_at DESC LIMIT 1",
        )
      ).status,
    ).toBe("cerrada");
    expect(
      (await one<{ status: string }>("SELECT status FROM tables_ WHERE number='T4'")).status,
    ).toBe("disponible");
    expect(caja.problems, caja.problems.join(" | ")).toEqual([]);
    await caja.ctx.close();
  });

  it("el cobro por partes iguales no cierra la cuenta hasta saldarla", async () => {
    const caja = await newPage(browser, nodo.url);
    await sessionFor(caja.page, nodo.url, "Caja", "3333");
    const p = caja.page;
    await tapPaged(p, "S8", ".table-card");
    await tap(p, "Cobrar", "button");
    await until(async () => (await p.$(".sheet")) || null, "ventana de cobro");
    await tap(p, "Partes iguales", ".sheet button");
    await until(
      async () => (await hasText(p, "Entre cuántas personas")) || null,
      "selector de partes",
    );
    // cada parte se paga con el monto que la ventana indica en «Este pago cubre»
    const share = await p.evaluate(() => {
      const t = (document.querySelector(".sheet") as HTMLElement).innerText;
      const m = /Este pago cubre\s*\$([0-9,]+\.[0-9]{2})/.exec(t);
      return m ? m[1]!.replace(",", "") : null;
    });
    expect(share).not.toBeNull();
    await tap(p, "Monto", "input");
    await p.keyboard.type(share!, { delay: 20 });
    await sleep(200);
    await tap(p, "Cobrar $", ".sheet button");
    await waitText(p, "Pago registrado");
    const acc = await one<{ status: string }>(
      "SELECT a.status FROM accounts a JOIN tables_ t ON t.id=a.table_id WHERE t.number='S8' ORDER BY a.opened_at DESC LIMIT 1",
    );
    expect(acc.status).not.toBe("cerrada"); // quedó una parte pendiente
    await caja.ctx.close();
  });
});

describe("5 · salud de la sesión", () => {
  it("ninguna pantalla del mesero produjo errores en consola ni peticiones fallidas", async () => {
    expect(waiter.problems, waiter.problems.join(" | ")).toEqual([]);
    await waiter.ctx.close();
  });
});
