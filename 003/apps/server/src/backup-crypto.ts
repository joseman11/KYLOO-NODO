import {
  type CipherGCM,
  type DecipherGCM,
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * Cifrado de los respaldos (formato NODOBK1): AES-256-GCM por bloques de 1 MiB.
 *
 *   cabecera (24 B): "NODOBK1\0" | versión u8 | tamaño de bloque u32 | prefijo de nonce 4 B | 7 B reservados
 *   por bloque:      longitud u32 | texto cifrado | etiqueta de autenticación (16 B)
 *
 * El nonce de cada bloque es prefijo(4) + contador(8). La etiqueta autentica además la cabecera, el número de bloque y si
 * es el último (AAD): un bloque alterado, cambiado de sitio o un archivo cortado **no descifra**. El último bloque puede ir
 * vacío (cuando el contenido es múltiplo exacto del tamaño de bloque).
 */
const MAGIC = Buffer.from("NODOBK1\0");
const VERSION = 1;
export const CHUNK = 1024 * 1024;
const HEADER = 24;
const TAG = 16;

export class BackupCryptoError extends Error {}

function header(prefix: Buffer, chunk = CHUNK) {
  const h = Buffer.alloc(HEADER);
  MAGIC.copy(h, 0);
  h.writeUInt8(VERSION, 8);
  h.writeUInt32BE(chunk, 9);
  prefix.copy(h, 13);
  return h;
}
const nonce = (prefix: Buffer, counter: number) => {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeBigUInt64BE(BigInt(counter), 4);
  return n;
};
const aad = (h: Buffer, counter: number, last: boolean) => {
  const a = Buffer.alloc(HEADER + 9);
  h.copy(a, 0);
  a.writeBigUInt64BE(BigInt(counter), HEADER);
  a.writeUInt8(last ? 1 : 0, HEADER + 8);
  return a;
};

/** Reagrupa un flujo de trozos en bloques exactos de `size` bytes (el último puede ser menor). */
async function* rechunk(source: AsyncIterable<Buffer>, size: number) {
  let buf = Buffer.alloc(0);
  for await (const part of source) {
    buf = buf.length ? Buffer.concat([buf, part]) : part;
    while (buf.length > size) {
      yield buf.subarray(0, size);
      buf = buf.subarray(size);
    }
  }
  yield buf; // el último (puede estar vacío)
}

/** Cifra un flujo. Devuelve trozos listos para escribirse. */
export async function* encryptStream(key: Buffer, source: AsyncIterable<Buffer>) {
  if (key.length !== 32) throw new BackupCryptoError("La clave debe ser de 256 bits");
  const prefix = randomBytes(4);
  const h = header(prefix);
  yield h;
  // Se retiene un bloque para saber cuál es el último antes de cifrarlo
  let counter = 0;
  let held: Buffer | null = null;
  const seal = (data: Buffer, last: boolean) => {
    const c: CipherGCM = createCipheriv("aes-256-gcm", key, nonce(prefix, counter));
    c.setAAD(aad(h, counter, last));
    const ct = Buffer.concat([c.update(data), c.final()]);
    const frame = Buffer.alloc(4);
    frame.writeUInt32BE(ct.length, 0);
    counter++;
    return Buffer.concat([frame, ct, c.getAuthTag()]);
  };
  for await (const block of rechunk(source, CHUNK)) {
    if (held) yield seal(held, false);
    held = block;
  }
  yield seal(held ?? Buffer.alloc(0), true);
}

/** Descifra un flujo producido por `encryptStream`. Lanza `BackupCryptoError` si algo no cuadra. */
export async function* decryptStream(key: Buffer, source: AsyncIterable<Buffer>) {
  if (key.length !== 32) throw new BackupCryptoError("La clave debe ser de 256 bits");
  let buf = Buffer.alloc(0);
  const it = source[Symbol.asyncIterator]();
  const need = async (n: number) => {
    while (buf.length < n) {
      const r = await it.next();
      if (r.done) return false;
      buf = buf.length ? Buffer.concat([buf, r.value]) : r.value;
    }
    return true;
  };
  if (!(await need(HEADER))) throw new BackupCryptoError("Archivo de respaldo incompleto");
  const h = Buffer.from(buf.subarray(0, HEADER));
  buf = buf.subarray(HEADER);
  if (!h.subarray(0, 8).equals(MAGIC) || h.readUInt8(8) !== VERSION)
    throw new BackupCryptoError("No es un respaldo de Nodo (o es de una versión no soportada)");
  const prefix = h.subarray(13, 17);
  const chunk = h.readUInt32BE(9);
  let counter = 0;
  for (;;) {
    if (!(await need(4))) throw new BackupCryptoError("Respaldo incompleto: faltan bloques");
    const len = buf.readUInt32BE(0);
    if (len > chunk) throw new BackupCryptoError("Bloque inválido");
    if (!(await need(4 + len + TAG)))
      throw new BackupCryptoError("Respaldo incompleto: bloque cortado");
    const ct = buf.subarray(4, 4 + len);
    const tag = buf.subarray(4 + len, 4 + len + TAG);
    buf = buf.subarray(4 + len + TAG);
    // Es el último si no queda nada más tras este bloque
    const last = !(await need(1));
    const d: DecipherGCM = createDecipheriv("aes-256-gcm", key, nonce(prefix, counter));
    d.setAAD(aad(h, counter, last));
    d.setAuthTag(tag);
    let plain: Buffer;
    try {
      plain = Buffer.concat([d.update(ct), d.final()]);
    } catch {
      throw new BackupCryptoError(
        "No se pudo descifrar: la clave no es la correcta o el respaldo está dañado o alterado",
      );
    }
    if (plain.length) yield plain;
    if (last) return;
    counter++;
  }
}

// ───────── Clave de recuperación ─────────
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const checksum = (key: Buffer) =>
  createHash("sha256").update("nodo-clave-recuperacion:").update(key).digest().subarray(0, 2);

export const newRecoveryKey = () => randomBytes(32);

/** Clave legible para guardar en papel: 55 símbolos en grupos de 5; los dos últimos bytes son una suma de control. */
export function formatRecoveryKey(key: Buffer): string {
  const data = Buffer.concat([key, checksum(key)]);
  let bits = "";
  for (const b of data) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5)
    out += B32[Number.parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out.replace(/(.{5})(?=.)/g, "$1-");
}

/** Lee una clave escrita a mano (mayúsculas o minúsculas, con o sin guiones). Devuelve null si tiene un error de tecleo. */
export function parseRecoveryKey(text: string): Buffer | null {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (clean.length !== 55) return null;
  let bits = "";
  for (const ch of clean) bits += B32.indexOf(ch).toString(2).padStart(5, "0");
  const bytes = Buffer.alloc(34);
  for (let i = 0; i < 34; i++) bytes[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const key = bytes.subarray(0, 32);
  return bytes.subarray(32).equals(checksum(key)) ? Buffer.from(key) : null;
}
