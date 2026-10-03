import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * Huella del equipo: identifica a esta máquina ante el HQ sin revelar su identificador real. Es `sha256("nodo:v1:" + id)`,
 * así que el identificador crudo (MachineGuid, IOPlatformUUID, machine-id) nunca sale del equipo.
 */
export const fingerprintOf = (machineId: string) =>
  createHash("sha256")
    .update(`nodo:v1:${machineId.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);

/** Forma corta y legible para dictarla por teléfono (`A1B2-C3D4-E5F6`). */
export const shortFingerprint = (fp: string) =>
  fp
    .slice(0, 12)
    .toUpperCase()
    .replace(/(.{4})(?=.)/g, "$1-");

export const parseWindowsGuid = (out: string) =>
  /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{8,})/.exec(out)?.[1] ?? null;
export const parseDarwinUuid = (out: string) =>
  /"IOPlatformUUID"\s*=\s*"([0-9a-fA-F-]{8,})"/.exec(out)?.[1] ?? null;

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { timeout: 5000, windowsHide: true }, (e, stdout) =>
      e ? reject(e) : resolve(String(stdout)),
    ),
  );

/** Identificador del equipo que mantiene el sistema operativo; `null` si no se pudo leer. */
export async function readMachineId(platform: NodeJS.Platform = process.platform) {
  try {
    if (platform === "win32")
      return parseWindowsGuid(
        await run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]),
      );
    if (platform === "darwin")
      return parseDarwinUuid(await run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]));
    for (const f of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      const id = (await readFile(f, "utf8").catch(() => "")).trim();
      if (id) return id;
    }
  } catch {
    /* sin identificador legible: la licencia atada al equipo no podrá comprobarse */
  }
  return null;
}

let cached: string | null | undefined;
/** Huella de este equipo (se calcula una vez por arranque). */
export async function machineFingerprint(): Promise<string | null> {
  if (cached === undefined) {
    const id = await readMachineId();
    cached = id ? fingerprintOf(id) : null;
  }
  return cached;
}
