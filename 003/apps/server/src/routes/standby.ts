import { createReadStream, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createBackupBundle } from "../backup-bundle";
import { verifySecret } from "../crypto";
import { audit } from "../db";
import { HttpError } from "../domain";
import {
  createPairing,
  noteStandbySeen,
  pairingKey,
  removePairing,
  standbyCipherKey,
  standbyStatus,
  tokenMatches,
} from "../standby";
import { formatRecoveryKey } from "../backup-crypto";

/**
 * Servidor de reserva, lado del principal (plan 07): emparejamiento, estado y la copia que descarga la reserva.
 * La copia es el mismo paquete de los respaldos (base + fotos), cifrado con una clave derivada del emparejamiento.
 */
export async function standbyRoutes(
  app: FastifyInstance,
  opts: { photosDir?: string; workDir: string },
) {
  const { db } = app;

  app.get("/api/standby/status", { preHandler: app.authorize("user.manage") }, async () =>
    standbyStatus(db),
  );

  // Las tablets aprenden aquí a dónde irse si este servidor se cae
  app.get("/api/standby/peers", { preHandler: app.authorize() }, async () => {
    const s = await standbyStatus(db);
    return { standby_url: s.paired && s.last_seen ? s.url : null };
  });

  /** Crea el emparejamiento (o lo rota) y muestra la clave; pide la contraseña de quien administra. */
  app.post("/api/standby/pairing", { preHandler: app.authorize("user.manage") }, async (req) => {
    const { password, rotate } = z
      .object({ password: z.string().min(1), rotate: z.boolean().optional() })
      .parse(req.body);
    const u = (await db.prepare("SELECT password_hash FROM users WHERE id=?").get(req.user.sub)) as
      | { password_hash: string | null }
      | undefined;
    if (!u || !verifySecret(password, u.password_hash))
      throw new HttpError(401, "credenciales_invalidas", "Contraseña incorrecta");
    const existing = await pairingKey(db);
    const key = existing && !rotate ? formatRecoveryKey(existing) : await createPairing(db);
    await audit(db, req.user.sub, "reserva_emparejamiento_mostrado", "sistema", undefined, {
      rotada: !!rotate,
    });
    return { key };
  });

  app.delete("/api/standby/pairing", { preHandler: app.authorize("user.manage") }, async (req) => {
    await removePairing(db);
    await audit(db, req.user.sub, "reserva_emparejamiento_retirado", "sistema");
    return { ok: true };
  });

  /** La reserva se identifica con un token derivado de la clave; sin emparejamiento no hay descarga. */
  app.get("/api/standby/snapshot", async (req, reply) => {
    const key = await pairingKey(db);
    if (!key || !tokenMatches(req.headers.authorization, key))
      throw new HttpError(401, "no_autenticado", "Reserva no emparejada");
    const out = join(opts.workDir, `reserva-${randomBytes(4).toString("hex")}.nbk`);
    const info = await createBackupBundle({
      db,
      photosDir: opts.photosDir,
      key: standbyCipherKey(key),
      outFile: out,
      tmpDir: opts.workDir,
    });
    const port = Number(req.headers["x-standby-port"]);
    const host = req.ip.replace(/^::ffff:/, "");
    await noteStandbySeen(
      db,
      `http://${host.includes(":") ? `[${host}]` : host}:${Number.isInteger(port) && port > 0 && port < 65536 ? port : 3003}`,
    );
    const stream = createReadStream(out);
    stream.on("close", () => rmSync(out, { force: true }));
    reply.header("content-type", "application/octet-stream");
    reply.header("content-length", String(statSync(out).size));
    reply.header("x-sha256", info.sha256);
    return reply.send(stream);
  });
}
