import { BIG, BOLD } from "./markup";

/** Codificador mínimo ESC/POS para impresoras térmicas (texto, negritas, doble tamaño, corte). */

const ESC = 0x1b;
const GS = 0x1d;

export interface EscposOptions {
  /** Corte automático al final. */
  cut?: boolean;
}

/** Convierte a CP858 (soporta acentos del español) para las impresoras habituales. */
const CP858: Record<string, number> = {
  á: 0xa0, é: 0x82, í: 0xa1, ó: 0xa2, ú: 0xa3, ñ: 0xa4, Ñ: 0xa5, ü: 0x81, Á: 0xb5, É: 0x90, Í: 0xd6, Ó: 0xe0, Ú: 0xe9,
  "¿": 0xa8, "¡": 0xad, "€": 0xd5,
};

function encodeText(s: string): number[] {
  return [...s].map((ch) => {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) return code;
    return CP858[ch] ?? 0x3f; // '?'
  });
}

/**
 * Líneas con marcas de control (ver markup.ts): BIG = negritas + doble alto/ancho, BOLD = negritas.
 * El resto se imprime tal cual.
 */
export function toEscpos(lines: string[], opts: EscposOptions = {}): Buffer {
  const out: number[] = [ESC, 0x40, ESC, 0x74, 19]; // init + code page CP858
  for (const raw of lines) {
    if (raw.startsWith(BIG)) out.push(ESC, 0x45, 1, GS, 0x21, 0x11, ...encodeText(raw.slice(1)), GS, 0x21, 0x00, ESC, 0x45, 0);
    else if (raw.startsWith(BOLD)) out.push(ESC, 0x45, 1, ...encodeText(raw.slice(1)), ESC, 0x45, 0);
    else out.push(...encodeText(raw));
    out.push(0x0a);
  }
  out.push(0x0a, 0x0a, 0x0a);
  if (opts.cut !== false) out.push(GS, 0x56, 0x42, 0x00); // corte parcial con avance
  return Buffer.from(out);
}
