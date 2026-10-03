import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BackupCryptoError,
  CHUNK,
  decryptStream,
  encryptStream,
  formatRecoveryKey,
  newRecoveryKey,
  parseRecoveryKey,
} from "../src/backup-crypto";

const key = randomBytes(32);
async function* from(...parts: Buffer[]) {
  for (const p of parts) yield p;
}
const collect = async (it: AsyncIterable<Buffer>) => {
  const parts: Buffer[] = [];
  for await (const p of it) parts.push(p);
  return Buffer.concat(parts);
};
const encrypt = (data: Buffer, k = key) => collect(encryptStream(k, from(data)));
const decrypt = (data: Buffer, k = key) => collect(decryptStream(k, from(data)));

describe("cifrado por bloques", () => {
  it("ida y vuelta de tamaños que tocan los bordes de bloque", async () => {
    for (const n of [0, 1, 15, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK, 2 * CHUNK + 7]) {
      const plain = randomBytes(n);
      expect((await decrypt(await encrypt(plain))).equals(plain), `tamaño ${n}`).toBe(true);
    }
  });

  it("no depende de cómo llegan los trozos de la entrada ni de la salida", async () => {
    const plain = randomBytes(CHUNK * 2 + 123);
    const pieces = [
      plain.subarray(0, 10),
      plain.subarray(10, CHUNK + 5),
      plain.subarray(CHUNK + 5),
    ];
    const enc = await collect(encryptStream(key, from(...pieces)));
    const tiny: Buffer[] = [];
    for (let i = 0; i < enc.length; i += 4099) tiny.push(enc.subarray(i, i + 4099));
    expect((await collect(decryptStream(key, from(...tiny)))).equals(plain)).toBe(true);
  });

  it("el texto cifrado no contiene el original y dos cifrados del mismo dato difieren", async () => {
    const plain = Buffer.from("venta de 1,035.00 mesa T4 ".repeat(100));
    const a = await encrypt(plain);
    const b = await encrypt(plain);
    expect(a.includes(Buffer.from("mesa T4"))).toBe(false);
    expect(a.equals(b)).toBe(false);
  });

  it("clave equivocada: falla con un mensaje claro", async () => {
    const enc = await encrypt(randomBytes(5000));
    await expect(decrypt(enc, randomBytes(32))).rejects.toThrow(/clave no es la correcta/);
  });

  it("un byte cambiado en cualquier parte se detecta", async () => {
    const enc = await encrypt(randomBytes(CHUNK + 500));
    for (const pos of [30, 1000, CHUNK + 100, enc.length - 5]) {
      const bad = Buffer.from(enc);
      bad[pos] = bad[pos]! ^ 0xff;
      await expect(decrypt(bad), `byte ${pos}`).rejects.toBeInstanceOf(BackupCryptoError);
    }
  });

  it("un archivo cortado (por el final o por un bloque entero) se detecta", async () => {
    const plain = randomBytes(CHUNK * 2 + 10);
    const enc = await encrypt(plain);
    await expect(decrypt(enc.subarray(0, enc.length - 1))).rejects.toBeInstanceOf(
      BackupCryptoError,
    );
    // se quita el último bloque entero: el penúltimo ya no está marcado como final
    const lastFrame = 4 + 10 + 16;
    await expect(decrypt(enc.subarray(0, enc.length - lastFrame))).rejects.toBeInstanceOf(
      BackupCryptoError,
    );
    await expect(decrypt(enc.subarray(0, 10))).rejects.toThrow(/incompleto/);
  });

  it("bloques reordenados no descifran", async () => {
    const enc = await encrypt(randomBytes(CHUNK * 3));
    const frame = 4 + CHUNK + 16;
    const h = enc.subarray(0, 24);
    const b0 = enc.subarray(24, 24 + frame);
    const b1 = enc.subarray(24 + frame, 24 + 2 * frame);
    const rest = enc.subarray(24 + 2 * frame);
    await expect(decrypt(Buffer.concat([h, b1, b0, rest]))).rejects.toBeInstanceOf(
      BackupCryptoError,
    );
  });

  it("rechaza lo que no es un respaldo de Nodo", async () => {
    await expect(decrypt(Buffer.from("esto no es un respaldo de nodo, para nada"))).rejects.toThrow(
      /No es un respaldo/,
    );
  });

  it("exige una clave de 256 bits", async () => {
    await expect(collect(encryptStream(Buffer.alloc(16), from(Buffer.from("x"))))).rejects.toThrow(
      /256/,
    );
  });
});

describe("clave de recuperación", () => {
  it("se escribe en grupos de 5, se lee con o sin guiones y en minúsculas", () => {
    const k = newRecoveryKey();
    const text = formatRecoveryKey(k);
    expect(text).toMatch(/^([A-Z2-7]{5}-){10}[A-Z2-7]{5}$/);
    expect(parseRecoveryKey(text)?.equals(k)).toBe(true);
    expect(parseRecoveryKey(text.toLowerCase().replace(/-/g, " "))?.equals(k)).toBe(true);
  });

  it("detecta un error de tecleo", () => {
    const text = formatRecoveryKey(newRecoveryKey());
    const bad = (text[0] === "A" ? "B" : "A") + text.slice(1);
    expect(parseRecoveryKey(bad)).toBeNull();
    expect(parseRecoveryKey("corta")).toBeNull();
  });
});
