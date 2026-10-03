/**
 * Genera el par de claves con el que Nodo firma las licencias:
 *   pnpm --filter @003/server keygen -- [--out <carpeta>] [--force]
 *
 * La clave PRIVADA se escribe fuera del repositorio (por defecto ~/.nodo-keys, permisos 600): va como secreto del HQ
 * (variable `HQ_SIGNING_KEY` en Railway) y en una copia de seguridad. La PÚBLICA se pasa al empaquetado
 * (`--license-public-key`) y puede guardarse en el repositorio. Nunca se sobrescribe un par existente sin --force.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { generateSigningKeys } from "./license";

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = resolve(opt("out") ?? join(homedir(), ".nodo-keys"));
const priv = join(out, "license-private.pem");
const pub = join(out, "license-public.pem");

if ((existsSync(priv) || existsSync(pub)) && !args.includes("--force")) {
  console.error(
    `Ya existe un par de claves en ${out}. Usa --force solo si sabes que no hay licencias emitidas con él.`,
  );
  process.exit(1);
}
mkdirSync(out, { recursive: true, mode: 0o700 });
const k = generateSigningKeys();
writeFileSync(priv, k.privateKey, { mode: 0o600 });
chmodSync(priv, 0o600);
writeFileSync(pub, k.publicKey);
console.log(
  `Clave privada: ${priv}  (SECRETA: al HQ como HQ_SIGNING_KEY y a una copia de seguridad)`,
);
console.log(`Clave pública: ${pub}  (para --license-public-key al empaquetar)\n`);
console.log(k.publicKey);
