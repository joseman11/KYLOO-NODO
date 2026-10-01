import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** Hash scrypt con sal por secreto (PIN o contraseña). Formato: salt:hash en hex. */
export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(secret, salt, 32).toString("hex")}`;
}

export function verifySecret(secret: string, stored: string | null): boolean {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(secret, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}
