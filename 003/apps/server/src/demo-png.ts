import { crc32, deflateSync } from "node:zlib";

/**
 * PNG de relleno para los platillos de la demo: degradado de color con un "plato" al centro.
 * No son fotos reales; sirven para ver cómo luce el menú con imágenes hasta que el negocio suba las suyas.
 */
export function placeholderPng(hue: number, w = 320, h = 240): Buffer {
  const hsl = (hh: number, s: number, l: number): [number, number, number] => {
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + hh / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  };
  const top = hsl(hue, 0.62, 0.62);
  const bottom = hsl((hue + 28) % 360, 0.66, 0.34);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const cx = w / 2;
  const cy = h / 2 + 4;
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filtro "ninguno"
    for (let x = 0; x < w; x++) {
      const t = y / (h - 1);
      let px = [0, 1, 2].map((i) => Math.round(top[i]! * (1 - t) + bottom[i]! * t));
      const d = Math.hypot(x - cx, (y - cy) * 1.15);
      if (d < 86) px = d < 68 ? hsl(hue, 0.5, 0.82) : [250, 250, 250]; // plato: borde claro y centro del color
      raw.set(px, y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 8 bits
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
