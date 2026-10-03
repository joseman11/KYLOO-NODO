import { join } from "node:path";
import { parseRecoveryKey } from "./backup-crypto";
import { loadConfig } from "./config";
import { writeStandby } from "./standby";

/** `server.mjs standby --of <url> --key <clave>` o `standby --off`. Devuelve el código de salida. */
export function standbyCli(args: string[]): number {
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const config = loadConfig();
  if (args.includes("--off")) {
    writeStandby(config.dataDir, null);
    console.log("Este equipo ya no es servidor de reserva. Reinicia el servicio de Nodo.");
    return 0;
  }
  const of = get("--of");
  const key = get("--key");
  if (!of || !key) {
    console.error(
      "Uso: server.mjs standby --of http://<ip-del-principal>:3003 --key <clave de emparejamiento>\n     server.mjs standby --off",
    );
    return 2;
  }
  let primary: string;
  try {
    const u = new URL(/^https?:\/\//i.test(of) ? of : `http://${of}`);
    primary = `${u.protocol}//${u.hostname}:${u.port || "3003"}`;
  } catch {
    console.error("La dirección del principal no es válida");
    return 2;
  }
  if (!parseRecoveryKey(key)) {
    console.error("La clave de emparejamiento tiene un error de tecleo");
    return 2;
  }
  writeStandby(config.dataDir, { primary, key });
  console.log(
    `Listo: este equipo será reserva de ${primary}. Reinicia el servicio de Nodo (datos en ${join(config.dataDir)}).`,
  );
  return 0;
}
