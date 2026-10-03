import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../db";
import { HttpError } from "../domain";

const MAX_BYTES = 800 * 1024;
const TYPES: Record<string, { ext: string; mime: string; magic: (b: Buffer) => boolean }> = {
  "image/jpeg": {
    ext: "jpg",
    mime: "image/jpeg",
    magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  "image/png": {
    ext: "png",
    mime: "image/png",
    magic: (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  },
  "image/webp": {
    ext: "webp",
    mime: "image/webp",
    magic: (b) =>
      b.subarray(0, 4).toString("latin1") === "RIFF" &&
      b.subarray(8, 12).toString("latin1") === "WEBP",
  },
};
const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
const FILE_RE = /^[a-f0-9]{24}-[a-f0-9]{8}\.(jpg|png|webp)$/;

/** Fotos de los platillos: el cliente las reduce antes de enviarlas; aquí se validan por tipo real y tamaño. */
export async function photoRoutes(app: FastifyInstance, opts: { dir: string }) {
  const { db } = app;
  app.post(
    "/api/products/:id/photo",
    { preHandler: app.authorize("product.modify") },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const { data } = z.object({ data: z.string().min(100) }).parse(req.body);
      const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(data);
      if (!m)
        throw new HttpError(400, "formato_invalido", "Solo se aceptan imágenes JPG, PNG o WebP");
      const type = TYPES[m[1]!]!;
      const bytes = Buffer.from(m[2]!, "base64");
      if (bytes.length > MAX_BYTES)
        throw new HttpError(413, "imagen_grande", "La foto pesa demasiado (máximo 800 KB)");
      // El contenido debe ser realmente de ese tipo, no solo decir que lo es
      if (!type.magic(bytes))
        throw new HttpError(400, "formato_invalido", "El archivo no es una imagen válida");

      const product = (await db.prepare("SELECT photo FROM products WHERE id=?").get(id)) as
        | { photo: string | null }
        | undefined;
      if (!product) throw new HttpError(404, "no_encontrado");
      const file = `${id}-${randomBytes(4).toString("hex")}.${type.ext}`;
      mkdirSync(opts.dir, { recursive: true }); // se crea al guardar la primera foto
      writeFileSync(join(opts.dir, file), bytes);
      await db.prepare("UPDATE products SET photo=? WHERE id=?").run(file, id);
      if (product.photo && FILE_RE.test(product.photo))
        rmSync(join(opts.dir, product.photo), { force: true });
      await audit(db, req.user.sub, "foto_producto", "product", id, { bytes: bytes.length });
      app.hub.emit({ type: "product.updated", productId: id });
      return { photo: file };
    },
  );

  app.delete(
    "/api/products/:id/photo",
    { preHandler: app.authorize("product.modify") },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const product = (await db.prepare("SELECT photo FROM products WHERE id=?").get(id)) as
        | { photo: string | null }
        | undefined;
      if (!product) throw new HttpError(404, "no_encontrado");
      await db.prepare("UPDATE products SET photo=NULL WHERE id=?").run(id);
      if (product.photo && FILE_RE.test(product.photo))
        rmSync(join(opts.dir, product.photo), { force: true });
      app.hub.emit({ type: "product.updated", productId: id });
      return { ok: true };
    },
  );

  // Las fotos son públicas (el menú QR las muestra sin sesión). El nombre del archivo es aleatorio y se valida estrictamente.
  app.get("/api/photos/:file", async (req, reply) => {
    const { file } = z.object({ file: z.string() }).parse(req.params);
    if (!FILE_RE.test(file)) return reply.code(404).send({ error: "no_encontrado" });
    const path = join(opts.dir, file);
    if (!existsSync(path)) return reply.code(404).send({ error: "no_encontrado" });
    return reply
      .header("content-type", MIME_BY_EXT[file.split(".")[1]!]!)
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("x-content-type-options", "nosniff")
      .send(readFileSync(path));
  });

  // Foto de cada trabajador: aparece en la pantalla de acceso
  const userPhoto = async (userId: string) =>
    (await db.prepare("SELECT photo FROM users WHERE id=?").get(userId)) as
      | { photo: string | null }
      | undefined;

  app.post("/api/users/:id/photo", { preHandler: app.authorize("user.manage") }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { data } = z.object({ data: z.string().min(100) }).parse(req.body);
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(data);
    if (!m)
      throw new HttpError(400, "formato_invalido", "Solo se aceptan imágenes JPG, PNG o WebP");
    const type = TYPES[m[1]!]!;
    const bytes = Buffer.from(m[2]!, "base64");
    if (bytes.length > MAX_BYTES)
      throw new HttpError(413, "imagen_grande", "La foto pesa demasiado (máximo 800 KB)");
    if (!type.magic(bytes))
      throw new HttpError(400, "formato_invalido", "El archivo no es una imagen válida");
    const user = await userPhoto(id);
    if (!user) throw new HttpError(404, "no_encontrado");
    const file = `${id}-${randomBytes(4).toString("hex")}.${type.ext}`;
    mkdirSync(opts.dir, { recursive: true });
    writeFileSync(join(opts.dir, file), bytes);
    await db.prepare("UPDATE users SET photo=? WHERE id=?").run(file, id);
    if (user.photo && FILE_RE.test(user.photo)) rmSync(join(opts.dir, user.photo), { force: true });
    await audit(db, req.user.sub, "foto_usuario", "user", id, { bytes: bytes.length });
    return { photo: file };
  });

  app.delete("/api/users/:id/photo", { preHandler: app.authorize("user.manage") }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const user = await userPhoto(id);
    if (!user) throw new HttpError(404, "no_encontrado");
    await db.prepare("UPDATE users SET photo=NULL WHERE id=?").run(id);
    if (user.photo && FILE_RE.test(user.photo)) rmSync(join(opts.dir, user.photo), { force: true });
    return { ok: true };
  });

  // Foto de cada receta del recetario
  const recipePhoto = async (rid: string) =>
    (await db.prepare("SELECT photo FROM recipe_book WHERE id=? AND active=1").get(rid)) as
      | { photo: string | null }
      | undefined;

  app.post(
    "/api/recipe-book/:id/photo",
    { preHandler: app.authorize("recipe.manage") },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const { data } = z.object({ data: z.string().min(100) }).parse(req.body);
      const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(data);
      if (!m)
        throw new HttpError(400, "formato_invalido", "Solo se aceptan imágenes JPG, PNG o WebP");
      const type = TYPES[m[1]!]!;
      const bytes = Buffer.from(m[2]!, "base64");
      if (bytes.length > MAX_BYTES)
        throw new HttpError(413, "imagen_grande", "La foto pesa demasiado (máximo 800 KB)");
      if (!type.magic(bytes))
        throw new HttpError(400, "formato_invalido", "El archivo no es una imagen válida");
      const rec = await recipePhoto(id);
      if (!rec) throw new HttpError(404, "no_encontrado");
      const file = `${id}-${randomBytes(4).toString("hex")}.${type.ext}`;
      mkdirSync(opts.dir, { recursive: true });
      writeFileSync(join(opts.dir, file), bytes);
      await db.prepare("UPDATE recipe_book SET photo=? WHERE id=?").run(file, id);
      if (rec.photo && FILE_RE.test(rec.photo)) rmSync(join(opts.dir, rec.photo), { force: true });
      return { photo: file };
    },
  );

  app.delete(
    "/api/recipe-book/:id/photo",
    { preHandler: app.authorize("recipe.manage") },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const rec = await recipePhoto(id);
      if (!rec) throw new HttpError(404, "no_encontrado");
      await db.prepare("UPDATE recipe_book SET photo=NULL WHERE id=?").run(id);
      if (rec.photo && FILE_RE.test(rec.photo)) rmSync(join(opts.dir, rec.photo), { force: true });
      return { ok: true };
    },
  );
}
