import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import { decodeQr } from "../../web/src/qr";
import { normalizeServer } from "../../web/src/server-address";

/** Pinta un código QR como imagen RGBA (cada módulo de `scale` píxeles, con su margen blanco). */
function render(text: string, scale = 8, quiet = 4, invert = false) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const size = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const my = Math.floor(y / scale) - quiet;
      const dark = mx >= 0 && my >= 0 && mx < n && my < n && qr.modules.get(mx, my) === 1;
      const v = dark !== invert ? 0 : 255;
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  return { data, size };
}

describe("lector del código QR de «Conectar»", () => {
  it("lee la dirección que muestra la pantalla del servidor", () => {
    const url = "http://192.168.1.20:3003";
    const { data, size } = render(url);
    expect(decodeQr(data, size, size)).toBe(url);
  });

  it("lee códigos pequeños y de direcciones largas", () => {
    for (const url of [
      "http://10.0.0.5:3003",
      "http://nodo.local:3003",
      "http://192.168.100.200:3003/",
    ]) {
      const { data, size } = render(url, 5);
      expect(decodeQr(data, size, size), url).toBe(url);
    }
  });

  it("no inventa nada cuando no hay un código en la imagen", () => {
    const blank = new Uint8ClampedArray(200 * 200 * 4).fill(255);
    expect(decodeQr(blank, 200, 200)).toBeNull();
  });

  it("lo leído se normaliza a la dirección del servidor", () => {
    expect(normalizeServer("http://192.168.1.20:3003")).toBe("http://192.168.1.20:3003");
    expect(normalizeServer("192.168.1.20")).toBe("http://192.168.1.20:3003");
    expect(normalizeServer("nodo.local")).toBe("http://nodo.local:3003");
    expect(normalizeServer("http://10.0.0.5:4000/")).toBe("http://10.0.0.5:4000");
    expect(normalizeServer("   ")).toBeNull();
    expect(normalizeServer("http://")).toBeNull();
    expect(normalizeServer("javascript://x")).toBeNull();
    expect(normalizeServer("ftp://10.0.0.5")).toBeNull();
  });
});
