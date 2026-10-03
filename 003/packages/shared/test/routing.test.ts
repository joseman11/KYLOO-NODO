import { describe, expect, it } from "vitest";
import {
  checkTransition,
  DEFAULT_ROLE_PERMISSIONS,
  MissingRouteError,
  routeOrder,
  type OrderItem,
} from "../src";

const caliente = {
  area: "Cocina",
  subarea: "Calientes",
  stationId: "st-cal",
  printerIds: ["p-cocina"],
};
const frios = { area: "Cocina", subarea: "Fríos", stationId: "st-fri", printerIds: ["p-frios"] };
const bar = { area: "Bar", subarea: "Coctelería", stationId: "st-bar", printerIds: ["p-bar"] };

const items: OrderItem[] = [
  { id: "1", productId: "hamb", name: "Hamburguesa", quantity: 1, routes: [caliente] },
  { id: "2", productId: "ens", name: "Ensalada", quantity: 1, routes: [frios] },
  { id: "3", productId: "mar", name: "Margarita", quantity: 2, routes: [bar] },
];

describe("routeOrder", () => {
  it("divide 1 hamburguesa + 1 ensalada + 2 margaritas en 3 tickets (sec. 12)", () => {
    const tickets = routeOrder(items);
    expect(tickets.map((t) => t.stationId).sort()).toEqual(["st-bar", "st-cal", "st-fri"]);
    expect(tickets.find((t) => t.stationId === "st-bar")!.lines[0]).toMatchObject({
      name: "Margarita",
      quantity: 2,
    });
  });

  it("agrupa productos de la misma estación en un solo ticket", () => {
    const tickets = routeOrder([
      ...items,
      { id: "4", productId: "alitas", name: "Alitas", quantity: 1, routes: [caliente] },
    ]);
    expect(tickets).toHaveLength(3);
    expect(tickets.find((t) => t.stationId === "st-cal")!.lines).toHaveLength(2);
  });

  it("un combo con varias rutas genera líneas en cada estación (RN-004)", () => {
    const combo: OrderItem = {
      id: "5",
      productId: "combo",
      name: "Combo",
      quantity: 1,
      routes: [caliente, bar],
    };
    expect(
      routeOrder([combo])
        .map((t) => t.stationId)
        .sort(),
    ).toEqual(["st-bar", "st-cal"]);
  });

  it("rechaza productos sin ruta (RN-003)", () => {
    expect(() =>
      routeOrder([{ id: "9", productId: "x", name: "X", quantity: 1, routes: [] }]),
    ).toThrow(MissingRouteError);
  });
});

describe("checkTransition", () => {
  it("permite enviar a un mesero y bloquea saltos de estado", () => {
    const mesero = DEFAULT_ROLE_PERMISSIONS.mesero;
    expect(checkTransition("borrador", "enviada", mesero)).toEqual({ ok: true });
    expect(checkTransition("borrador", "entregada", mesero)).toEqual({
      ok: false,
      reason: "invalid_transition",
    });
  });

  it("un mesero no puede marcar preparada una comanda", () => {
    expect(checkTransition("en_preparacion", "preparada", DEFAULT_ROLE_PERMISSIONS.mesero)).toEqual(
      {
        ok: false,
        reason: "forbidden",
      },
    );
    expect(checkTransition("en_preparacion", "preparada", DEFAULT_ROLE_PERMISSIONS.cocina)).toEqual(
      { ok: true },
    );
  });
});
