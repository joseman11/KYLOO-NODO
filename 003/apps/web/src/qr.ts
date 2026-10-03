import jsQR from "jsqr";

/** Texto de un código QR dentro de una imagen (píxeles RGBA), o `null` si no hay ninguno legible. */
export function decodeQr(data: Uint8ClampedArray, width: number, height: number): string | null {
  return jsQR(data, width, height, { inversionAttempts: "dontInvert" })?.data ?? null;
}
