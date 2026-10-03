/**
 * Compila el APK de la app de tablet:
 *   JAVA_HOME=<JDK 17 a 21> ANDROID_HOME=<SDK> node scripts/build-apk.mjs [--release]
 *
 * 1) compila la interfaz web, 2) la copia dentro del proyecto Android (cap sync), 3) Gradle.
 * El APK queda en apps/mobile/dist/. «--release» exige las variables de firma (NODO_KEYSTORE, NODO_KEYSTORE_PASSWORD,
 * NODO_KEY_ALIAS, NODO_KEY_PASSWORD); sin ellas solo se genera el APK de depuración (se instala, pero no es para entregar).
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");
const ROOT = resolve(MOBILE, "../..");
const release = process.argv.includes("--release");
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: process.env });

const home = process.env.JAVA_HOME;
if (!home || !existsSync(join(home, "bin/java")))
  throw new Error("Define JAVA_HOME con un JDK 17 a 21 (Gradle no soporta aún los más nuevos)");
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (!sdk || !existsSync(sdk))
  throw new Error("Define ANDROID_HOME con la carpeta del SDK de Android");
if (release && !process.env.NODO_KEYSTORE)
  throw new Error("Falta NODO_KEYSTORE para firmar el APK de entrega");

const version = JSON.parse(readFileSync(join(ROOT, "apps/server/package.json"), "utf8")).version;
console.log("▸ compilando la interfaz web");
run("npx", ["-y", "pnpm@11.21.0", "--filter", "@003/web", "build"], ROOT);
console.log("▸ copiando la interfaz al proyecto Android");
run("npx", ["cap", "sync", "android"], MOBILE);
console.log(`▸ Gradle (${release ? "release" : "debug"})`);
run(
  join(MOBILE, "android/gradlew"),
  [release ? "assembleRelease" : "assembleDebug", "--no-daemon"],
  join(MOBILE, "android"),
);

const out = join(
  MOBILE,
  "android/app/build/outputs/apk",
  release ? "release" : "debug",
  release ? "app-release.apk" : "app-debug.apk",
);
mkdirSync(join(MOBILE, "dist"), { recursive: true });
const dest = join(MOBILE, "dist", `nodo-${version}-${release ? "release" : "debug"}.apk`);
copyFileSync(out, dest);
console.log(`✔ ${dest}`);
