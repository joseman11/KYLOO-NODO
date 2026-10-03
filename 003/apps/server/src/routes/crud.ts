import type { FastifyInstance } from "fastify";
import { z, type ZodRawShape } from "zod";
import type { Permission } from "@003/shared";
import { audit, newId } from "../db";

type Primitive = string | number | boolean | null;

const toSql = (v: Primitive | undefined) => (typeof v === "boolean" ? (v ? 1 : 0) : (v ?? null));

/**
 * CRUD genérico para tablas simples. Las claves del esquema Zod son los nombres de columna
 * (por eso solo salen de código, nunca de la petición). Toda escritura queda en auditoría.
 */
export function crud(
  app: FastifyInstance,
  opts: {
    path: string;
    table: string;
    entity: string;
    write: Permission;
    read?: Permission;
    shape: ZodRawShape;
    orderBy?: string;
    /** Devuelve un mensaje para impedir el borrado (p. ej. "tiene productos") o null si se puede borrar. */
    canDelete?: (id: string) => string | null | Promise<string | null>;
    /** Validación de negocio al crear (id null) o editar: devuelve un mensaje de error o null. */
    validate?: (
      body: Record<string, unknown>,
      id: string | null,
    ) => string | null | Promise<string | null>;
  },
) {
  const { db } = app;
  const create = z.object(opts.shape);
  const patch = create.partial();
  const cols = Object.keys(opts.shape);

  app.get(opts.path, { preHandler: app.authorize(opts.read) }, async () =>
    db.prepare(`SELECT * FROM ${opts.table} ORDER BY ${opts.orderBy ?? "rowid"}`).all(),
  );

  app.post(opts.path, { preHandler: app.authorize(opts.write) }, async (req, reply) => {
    const body = create.parse(req.body) as Record<string, Primitive>;
    const invalid = await opts.validate?.(body, null);
    if (invalid) return reply.code(400).send({ error: "validacion", message: invalid });
    const id = newId();
    const names = ["id", ...cols];
    await db
      .prepare(
        `INSERT INTO ${opts.table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`,
      )
      .run(id, ...cols.map((c) => toSql(body[c])));
    await audit(db, req.user.sub, "crear", opts.entity, id, body);
    return reply.code(201).send({ id });
  });

  app.patch(`${opts.path}/:id`, { preHandler: app.authorize(opts.write) }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = patch.parse(req.body) as Record<string, Primitive | undefined>;
    const invalid = await opts.validate?.(body, id);
    if (invalid) return reply.code(400).send({ error: "validacion", message: invalid });
    const keys = cols.filter((c) => body[c] !== undefined);
    if (keys.length === 0)
      return reply.code(400).send({ error: "validacion", message: "Sin cambios" });
    const r = await db
      .prepare(`UPDATE ${opts.table} SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`)
      .run(...keys.map((k) => toSql(body[k])), id);
    if (r.changes === 0) return reply.code(404).send({ error: "no_encontrado" });
    await audit(db, req.user.sub, "editar", opts.entity, id, body);
    return { ok: true };
  });

  app.delete(`${opts.path}/:id`, { preHandler: app.authorize(opts.write) }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const blocked = await opts.canDelete?.(id);
    if (blocked) return reply.code(409).send({ error: "no_se_puede_eliminar", message: blocked });
    const r = await db.prepare(`DELETE FROM ${opts.table} WHERE id=?`).run(id);
    if (r.changes === 0) return reply.code(404).send({ error: "no_encontrado" });
    await audit(db, req.user.sub, "eliminar", opts.entity, id);
    return { ok: true };
  });
}
