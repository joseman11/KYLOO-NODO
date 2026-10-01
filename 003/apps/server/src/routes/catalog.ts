import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, newId } from "../db";
import { HttpError } from "../domain";
import { crud } from "./crud";

interface ProductRow {
  id: string;
  [k: string]: unknown;
}

const productShape = {
  category_id: z.string().nullable().optional(),
  name: z.string().min(1),
  sku: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  price_cents: z.number().int().min(0),
  tax_rate: z.number().min(0).max(1).default(0.16),
  prep_minutes: z.number().int().min(0).nullable().optional(),
  availability: z.enum(["disponible", "agotado", "temporal"]).default("disponible"),
  active: z.boolean().default(true),
};

export async function catalogRoutes(app: FastifyInstance) {
  const { db } = app;

  crud(app, {
    path: "/api/categories", table: "categories", entity: "category", write: "product.modify", orderBy: "sort, name",
    shape: { parent_id: z.string().nullable().optional(), name: z.string().trim().min(1), sort: z.number().int().default(0) },
    validate: (b, cid) => {
      const parent = b.parent_id as string | null | undefined;
      if (!parent) return null;
      if (!db.prepare("SELECT 1 FROM categories WHERE id=?").get(parent)) return "La categoría padre no existe";
      // Sin ciclos ni más de 3 niveles (Tacos › De calamar › Picantes)
      let depth = 1;
      for (let cur: string | null = parent; cur && depth < 10; depth++) {
        if (cid && cur === cid) return "Una categoría no puede quedar dentro de sí misma";
        cur = (db.prepare("SELECT parent_id FROM categories WHERE id=?").get(cur) as { parent_id: string | null } | undefined)?.parent_id ?? null;
      }
      return depth > 3 ? "Máximo 3 niveles de categorías" : null;
    },
    canDelete: (cid) => {
      const kids = (db.prepare("SELECT COUNT(*) c FROM categories WHERE parent_id=?").get(cid) as { c: number }).c;
      if (kids) return `La categoría tiene ${kids} subcategoría(s): elimínalas o muévelas primero`;
      const prods = (db.prepare("SELECT COUNT(*) c FROM products WHERE category_id=?").get(cid) as { c: number }).c;
      return prods ? `La categoría tiene ${prods} producto(s): muévelos a otra categoría primero` : null;
    },
  });

  // --- Destino por categoría: los productos nuevos de la categoría (y de sus subcategorías) lo heredan ---
  /** Estaciones de una categoría; si no tiene, las de su categoría padre, y así hacia arriba. */
  const inheritedStations = (categoryId: string | null | undefined): string[] => {
    let cur = categoryId ?? null;
    for (let depth = 0; cur && depth < 10; depth++) {
      const rows = db.prepare("SELECT station_id FROM category_routes WHERE category_id=?").all(cur) as { station_id: string }[];
      if (rows.length) return rows.map((r) => r.station_id);
      cur = (db.prepare("SELECT parent_id FROM categories WHERE id=?").get(cur) as { parent_id: string | null } | undefined)?.parent_id ?? null;
    }
    return [];
  };
  const descendants = (categoryId: string): string[] => {
    const out = [categoryId];
    for (let i = 0; i < out.length && out.length < 500; i++) {
      for (const k of db.prepare("SELECT id FROM categories WHERE parent_id=?").all(out[i]) as { id: string }[]) out.push(k.id);
    }
    return out;
  };

  app.get("/api/category-routes", { preHandler: app.authorize() }, async () => db.prepare("SELECT category_id, station_id FROM category_routes").all());

  app.put("/api/categories/:id/routes", { preHandler: app.authorize("product.modify") }, async (req) => {
    const { id: cid } = z.object({ id: z.string() }).parse(req.params);
    const b = z.object({ station_ids: z.array(z.string()), apply_to_products: z.boolean().default(false) }).parse(req.body);
    if (!db.prepare("SELECT 1 FROM categories WHERE id=?").get(cid)) throw new HttpError(404, "no_encontrado");
    let updated = 0;
    db.transaction(() => {
      db.prepare("DELETE FROM category_routes WHERE category_id=?").run(cid);
      for (const s of b.station_ids) db.prepare("INSERT INTO category_routes (category_id, station_id) VALUES (?,?)").run(cid, s);
      // Reasignar los productos que ya existen en la categoría y sus subcategorías
      if (b.apply_to_products && b.station_ids.length) {
        const ids = descendants(cid);
        const products = db.prepare(`SELECT id FROM products WHERE category_id IN (${ids.map(() => "?").join(",")})`).all(...ids) as { id: string }[];
        for (const p of products) {
          db.prepare("DELETE FROM product_routes WHERE product_id=?").run(p.id);
          for (const s of b.station_ids) db.prepare("INSERT INTO product_routes (product_id, station_id) VALUES (?,?)").run(p.id, s);
        }
        updated = products.length;
      }
    })();
    audit(db, req.user.sub, "destino_categoria", "category", cid, { stations: b.station_ids.length, productos: updated });
    return { ok: true, updated_products: updated };
  });

  // --- Grupos de modificadores con sus opciones ---
  const groupBody = z.object({
    name: z.string().min(1),
    required: z.boolean().default(false),
    multiple: z.boolean().default(false),
    max_select: z.number().int().min(1).nullable().optional(),
    modifiers: z.array(z.object({ name: z.string().min(1), price_cents: z.number().int().min(0).default(0) })).min(1),
  });

  app.get("/api/modifier-groups", { preHandler: app.authorize() }, async () => {
    const groups = db.prepare("SELECT * FROM modifier_groups ORDER BY name").all() as { id: string }[];
    const mods = db.prepare("SELECT * FROM modifiers ORDER BY rowid").all() as { group_id: string }[];
    return groups.map((g) => ({ ...g, modifiers: mods.filter((m) => m.group_id === g.id) }));
  });

  app.post("/api/modifier-groups", { preHandler: app.authorize("product.modify") }, async (req, reply) => {
    const b = groupBody.parse(req.body);
    const id = newId();
    db.transaction(() => {
      db.prepare("INSERT INTO modifier_groups (id,name,required,multiple,max_select) VALUES (?,?,?,?,?)").run(
        id, b.name, b.required ? 1 : 0, b.multiple ? 1 : 0, b.max_select ?? null,
      );
      for (const m of b.modifiers) {
        db.prepare("INSERT INTO modifiers (id,group_id,name,price_cents) VALUES (?,?,?,?)").run(newId(), id, m.name, m.price_cents);
      }
    })();
    audit(db, req.user.sub, "crear", "modifier_group", id, { name: b.name });
    return reply.code(201).send({ id });
  });

  app.delete("/api/modifier-groups/:id", { preHandler: app.authorize("product.modify") }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const r = db.prepare("DELETE FROM modifier_groups WHERE id=?").run(id);
    if (r.changes === 0) return reply.code(404).send({ error: "no_encontrado" });
    audit(db, req.user.sub, "eliminar", "modifier_group", id);
    return { ok: true };
  });

  // --- Productos: ruta de producción obligatoria (RN-003) y modificadores ---
  const createBody = z.object({
    ...productShape,
    // Si no se indica, hereda el destino de su categoría
    station_ids: z.array(z.string()).default([]),
    modifier_group_ids: z.array(z.string()).default([]),
  });
  const patchBody = z
    .object({ ...productShape, station_ids: z.array(z.string()).min(1), modifier_group_ids: z.array(z.string()) })
    .partial();

  const productCols = Object.keys(productShape);
  const sqlVal = (v: unknown) => (typeof v === "boolean" ? (v ? 1 : 0) : v ?? null);

  function setLinks(id: string, stations?: string[], groups?: string[]) {
    if (stations) {
      db.prepare("DELETE FROM product_routes WHERE product_id=?").run(id);
      for (const s of stations) db.prepare("INSERT INTO product_routes (product_id, station_id) VALUES (?,?)").run(id, s);
    }
    if (groups) {
      db.prepare("DELETE FROM product_modifier_groups WHERE product_id=?").run(id);
      for (const g of groups) db.prepare("INSERT INTO product_modifier_groups (product_id, group_id) VALUES (?,?)").run(id, g);
    }
  }

  app.get("/api/products", { preHandler: app.authorize() }, async () => {
    const products = db.prepare("SELECT * FROM products ORDER BY name").all() as ProductRow[];
    const routes = db.prepare("SELECT * FROM product_routes").all() as { product_id: string; station_id: string }[];
    const groups = db.prepare("SELECT * FROM product_modifier_groups").all() as { product_id: string; group_id: string }[];
    return products.map((p) => ({
      ...p,
      station_ids: routes.filter((r) => r.product_id === p.id).map((r) => r.station_id),
      modifier_group_ids: groups.filter((g) => g.product_id === p.id).map((g) => g.group_id),
    }));
  });

  app.post("/api/products", { preHandler: app.authorize("product.create") }, async (req, reply) => {
    const b = createBody.parse(req.body) as Record<string, unknown> & { station_ids: string[]; modifier_group_ids: string[]; category_id?: string | null };
    if (b.station_ids.length === 0) b.station_ids = inheritedStations(b.category_id);
    if (b.station_ids.length === 0) {
      throw new HttpError(400, "sin_destino", "Elige a qué área se envía (cocina, barra…) o define el destino de la categoría (RN-003)");
    }
    const id = newId();
    db.transaction(() => {
      db.prepare(`INSERT INTO products (id,${productCols.join(",")}) VALUES (?,${productCols.map(() => "?").join(",")})`).run(
        id, ...productCols.map((c) => sqlVal(b[c])),
      );
      setLinks(id, b.station_ids, b.modifier_group_ids);
    })();
    audit(db, req.user.sub, "crear", "product", id, { name: b.name, price_cents: b.price_cents });
    app.hub.emit({ type: "product.updated", productId: id });
    return reply.code(201).send({ id });
  });

  app.patch("/api/products/:id", { preHandler: app.authorize("product.modify") }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = patchBody.parse(req.body) as Record<string, unknown> & { station_ids?: string[]; modifier_group_ids?: string[] };
    const keys = productCols.filter((c) => b[c] !== undefined);
    const exists = db.prepare("SELECT 1 FROM products WHERE id=?").get(id);
    if (!exists) return reply.code(404).send({ error: "no_encontrado" });
    db.transaction(() => {
      if (keys.length) db.prepare(`UPDATE products SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`).run(...keys.map((k) => sqlVal(b[k])), id);
      setLinks(id, b.station_ids, b.modifier_group_ids);
    })();
    audit(db, req.user.sub, "editar", "product", id, b);
    app.hub.emit({ type: "product.updated", productId: id });
    return { ok: true };
  });

  // Marcar agotado: también lo puede hacer cocina (HU-026)
  app.post("/api/products/:id/availability", { preHandler: app.authorize("station.update") }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { availability } = z.object({ availability: z.enum(["disponible", "agotado", "temporal"]) }).parse(req.body);
    const r = db.prepare("UPDATE products SET availability=? WHERE id=?").run(availability, id);
    if (r.changes === 0) return reply.code(404).send({ error: "no_encontrado" });
    audit(db, req.user.sub, "disponibilidad", "product", id, { availability });
    app.hub.emit({ type: "product.updated", productId: id });
    return { ok: true };
  });

  app.delete("/api/products/:id", { preHandler: app.authorize("product.modify") }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const r = db.prepare("DELETE FROM products WHERE id=?").run(id);
    if (r.changes === 0) return reply.code(404).send({ error: "no_encontrado" });
    audit(db, req.user.sub, "eliminar", "product", id);
    return { ok: true };
  });

  app.get("/api/audit", { preHandler: app.authorize("reports.view") }, async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit);
  });
}
