import { describe, expect, it } from "vitest";
import { toEscpos } from "../src/printing/escpos";
import { renderComanda, type ComandaData } from "../src/printing/render";
import { HUGE, stripMarkup } from "../src/printing/markup";

const data = (table: string, kind: ComandaData["kind"] = "comanda"): ComandaData =>
  ({
    kind,
    stationLabel: "Cocina / Parrilla",
    tableNumber: table,
    waiter: "Juan",
    folio: 794,
    createdAt: Date.UTC(2026, 9, 1, 15, 12),
    lines: [
      { quantity: 2, name: "Camarones al mojo de ajo", modifiers: ["Arroz"], note: "sin ajo" },
    ],
  }) as ComandaData;

describe("comanda impresa para cocina", () => {
  it("el número de mesa va solo, en su propia línea, con la marca de tamaño máximo", () => {
    const lines = renderComanda(data("T3"));
    const i = lines.findIndex((l) => l.startsWith(HUGE));
    expect(i).toBeGreaterThan(-1);
    expect(lines[i]).toBe(`${HUGE}T3`);
    expect(stripMarkup(lines[i - 1]!)).toBe("MESA"); // rótulo pequeño encima
  });

  it("en la impresora sale centrado y a 4× de alto y ancho, y luego vuelve a tamaño normal", () => {
    const buf = toEscpos(renderComanda(data("S10")));
    const hex = buf.toString("hex");
    // ESC a 1 (centrar) · GS ! 0x33 (4×4) · "S10" · GS ! 0x00 · ESC a 0
    expect(hex).toContain(
      "1b6101" +
        "1b4501" +
        "1d2133" +
        Buffer.from("S10").toString("hex") +
        "1d2100" +
        "1b4500" +
        "1b6100",
    );
  });

  it("también se agranda en las adiciones y funciona con números largos y con nombre de zona", () => {
    for (const t of ["P1", "B12", "T3"]) {
      const adicion = renderComanda(data(t, "adicion"));
      expect(adicion).toContain(`${HUGE}${t}`);
      expect(adicion[0]).toContain("ADICION");
    }
  });

  it("el resto de la comanda no cambia (mesero, folio, platillos, extras y notas)", () => {
    const text = renderComanda(data("T3")).map(stripMarkup).join("\n");
    expect(text).toContain("Mesero: Juan");
    expect(text).toContain("#794");
    expect(text).toContain("2 x Camarones al mojo de ajo");
    expect(text).toContain("- Arroz");
    expect(text).toContain(">> sin ajo");
  });

  it("la vista previa (sin marcas) muestra MESA y el número en renglones separados", () => {
    const text = renderComanda(data("T3")).map(stripMarkup);
    const k = text.indexOf("MESA");
    expect(text[k + 1]).toBe("T3");
  });
});
