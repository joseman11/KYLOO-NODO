/**
 * Reduce una foto antes de subirla: lado mayor de 720 px y JPEG al 82 %. Una foto de celular de varios MB
 * queda en ~60–120 KB, así el menú carga rápido en la red local y el servidor no guarda archivos enormes.
 */
export async function resizeImage(
  file: File,
  maxSide = 720,
  quality = 0.82,
  square = false,
): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error("No se pudo leer la imagen");
  // Retrato: recorte cuadrado centrado
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = square ? (bitmap.width - side) / 2 : 0;
  const sy = square ? (bitmap.height - side) / 2 : 0;
  const sw = square ? side : bitmap.width;
  const sh = square ? side : bitmap.height;
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No se pudo procesar la imagen");
  ctx.fillStyle = "#fff"; // los PNG con transparencia quedan sobre fondo blanco
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", quality);
}
