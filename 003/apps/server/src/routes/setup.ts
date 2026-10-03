import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashSecret } from "../crypto";
import { audit, newId } from "../db";
import { HttpError } from "../domain";

/** Contraseñas que no se aceptan aunque cumplan el largo: son las primeras que se prueban contra cualquier sistema. */
const COMMON = new Set([
  "admin1234",
  "12345678",
  "123456789",
  "password",
  "contraseña",
  "qwertyui",
  "nodo1234",
]);

const setupSchema = z.object({
  establishment: z.string().trim().min(1).max(80),
  adminName: z.string().trim().min(1).max(60),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9._-]{3,30}$/,
      "El usuario usa de 3 a 30 letras, números, punto, guion o guion bajo",
    ),
  password: z
    .string()
    .min(8, "La contraseña debe tener al menos 8 caracteres")
    .max(200)
    .refine((p) => !COMMON.has(p.toLowerCase()), "Esa contraseña es demasiado común"),
});

/**
 * Primer arranque: una instalación nueva no trae usuarios ni claves. Mientras no exista ningún usuario, cualquiera
 * en la red local puede crear al administrador; en cuanto existe uno, la ruta deja de funcionar para siempre.
 * (Instalar es una acción de quien tiene el equipo delante: la ventana de exposición es la de la instalación.)
 */
export async function setupRoutes(app: FastifyInstance) {
  const { db } = app;
  const needsSetup = async () =>
    ((await db.prepare("SELECT COUNT(*) c FROM users").get()) as { c: number }).c === 0;

  app.get("/api/setup/status", async () => ({ needsSetup: await needsSetup() }));

  app.post("/api/setup", async (req, reply) => {
    const body = setupSchema.parse(req.body);
    let created = false;
    // Dos solicitudes simultáneas: la transacción vuelve a comprobar dentro y solo gana una
    await db.transaction(async () => {
      if (!(await needsSetup())) return;
      const id = newId();
      await db
        .prepare(
          "INSERT INTO users (id,name,username,role,password_hash,created_at) VALUES (?,?,?,?,?,?)",
        )
        .run(id, body.adminName, body.username, "admin", hashSecret(body.password), Date.now());
      await db
        .prepare(
          "INSERT INTO settings (key,value) VALUES ('establishment_name',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(body.establishment);
      await audit(db, id, "setup.completed", "user", id, { establishment: body.establishment });
      created = true;
    })();
    if (!created) throw new HttpError(409, "ya_configurado", "Este equipo ya está configurado");
    return reply.code(201).send({ ok: true });
  });
}
