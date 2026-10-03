import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { verifySecret } from "../crypto";
import { audit } from "../db";
import { HttpError } from "../domain";
import {
  type CloudBackupDeps,
  cloudBackupStatus,
  ensureRecoveryKey,
  recoveryKeyText,
  runCloudBackup,
} from "../cloud-backup";
import { formatRecoveryKey } from "../backup-crypto";
import { machineFingerprint } from "../fingerprint";

/** Respaldo cifrado en la nube: estado, clave de recuperación y «respaldar ahora» (plan 04). */
export async function cloudBackupRoutes(
  app: FastifyInstance,
  opts: Omit<CloudBackupDeps, "fingerprint">,
) {
  const { db } = app;
  const deps = async (): Promise<CloudBackupDeps> => ({
    ...opts,
    fingerprint: app.licensing.fingerprint ?? (await machineFingerprint()),
  });
  const setKey = (k: string, v: string) =>
    db
      .prepare(
        "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(k, v);

  app.get("/api/cloud/backup/status", { preHandler: app.authorize("user.manage") }, async () =>
    cloudBackupStatus(db),
  );

  /**
   * La clave de recuperación se muestra mientras no se haya confirmado que se guardó. Después ya no sale sin volver a
   * demostrar la contraseña (`/key/show`): cuantas menos veces aparezca en pantalla, mejor.
   */
  app.post("/api/cloud/backup/key", { preHandler: app.authorize("user.manage") }, async (req) => {
    const s = await cloudBackupStatus(db);
    if (s.keyConfirmed)
      throw new HttpError(
        409,
        "clave_confirmada",
        "La clave ya se confirmó; para verla de nuevo escribe tu contraseña",
      );
    await audit(db, req.user.sub, "clave_recuperacion_mostrada", "sistema");
    return { key: await recoveryKeyText(db) };
  });

  app.post(
    "/api/cloud/backup/key/confirm",
    { preHandler: app.authorize("user.manage") },
    async (req) => {
      if (!(await cloudBackupStatus(db)).keyCreated)
        throw new HttpError(409, "sin_clave", "Todavía no se ha creado la clave");
      await setKey("backup_key_confirmed", "1");
      await audit(db, req.user.sub, "clave_recuperacion_confirmada", "sistema");
      return { ok: true };
    },
  );

  app.post(
    "/api/cloud/backup/key/show",
    { preHandler: app.authorize("user.manage") },
    async (req) => {
      const { password } = z.object({ password: z.string().min(1) }).parse(req.body);
      const u = (await db
        .prepare("SELECT password_hash FROM users WHERE id=?")
        .get(req.user.sub)) as { password_hash: string | null } | undefined;
      if (!u || !verifySecret(password, u.password_hash))
        throw new HttpError(401, "credenciales_invalidas", "Contraseña incorrecta");
      await audit(db, req.user.sub, "clave_recuperacion_mostrada", "sistema");
      return { key: formatRecoveryKey(await ensureRecoveryKey(db)) };
    },
  );

  app.post("/api/cloud/backup/now", { preHandler: app.authorize("user.manage") }, async (req) => {
    const r = await runCloudBackup(db, await deps());
    await audit(db, req.user.sub, "respaldo_nube_manual", "sistema", undefined, {
      ok: r.ok,
      ...(r.ok ? { size: r.size } : { code: r.code }),
    });
    return r;
  });
}
