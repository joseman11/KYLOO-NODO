import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, newId, type Db } from "../db";
import { HttpError } from "../domain";
import { crud } from "./crud";

const id = z.object({ id: z.string() });
const round2 = (n: number) => Math.round(n * 100) / 100;
const qtyText = (n: number) => (Math.round(n * 100) / 100).toString();

interface RecipeRow {
  id: string;
  name: string;
  category_id: string | null;
  description: string | null;
  instructions: string | null;
  yield: number;
  yield_unit: string;
  prep_minutes: number | null;
  photo: string | null;
  product_id: string | null;
  active: number;
  created_at: number;
  updated_at: number;
}
interface Ingredient {
  id: string;
  item_id: string | null;
  name: string;
  quantity: number;
  unit: string | null;
  note: string | null;
  stock: number | null;
  unit_cost_cents: number | null;
  item_unit: string | null;
}

const ingredientsOf = async (db: Db, recipeId: string) =>
  (await db
    .prepare(
      `SELECT r.id, r.item_id, r.name, r.quantity, r.unit, r.note, i.stock, i.unit_cost_cents, i.unit AS item_unit
       FROM recipe_book_items r LEFT JOIN inventory_items i ON i.id=r.item_id WHERE r.recipe_id=? ORDER BY r.sort, r.rowid`,
    )
    .all(recipeId)) as Ingredient[];

/** Costo del lote completo con el costo promedio actual de cada insumo ligado al inventario. */
const batchCost = (ing: Ingredient[]) =>
  ing.reduce(
    (s, l) => s + (l.item_id && l.unit_cost_cents != null ? l.quantity * l.unit_cost_cents : 0),
    0,
  );

/** Texto de la receta para imprimir o compartir, escalado a las porciones pedidas. */
export async function recipeText(db: Db, recipeId: string, portions?: number): Promise<string> {
  const r = (await db
    .prepare(
      "SELECT r.*, c.name AS category FROM recipe_book r LEFT JOIN recipe_categories c ON c.id=r.category_id WHERE r.id=?",
    )
    .get(recipeId)) as (RecipeRow & { category: string | null }) | undefined;
  if (!r) throw new HttpError(404, "no_encontrado");
  const factor = portions && portions > 0 ? portions / r.yield : 1;
  const out = [
    r.name.toUpperCase(),
    [
      r.category,
      `${qtyText(r.yield * factor)} ${r.yield_unit}`,
      r.prep_minutes ? `${r.prep_minutes} min` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    "",
  ];
  if (r.description) out.push(r.description, "");
  out.push("INGREDIENTES");
  for (const l of await ingredientsOf(db, recipeId))
    out.push(
      `- ${qtyText(l.quantity * factor)} ${l.unit ?? l.item_unit ?? ""} ${l.name}`.replace(
        /\s+/g,
        " ",
      ) + (l.note ? ` (${l.note})` : ""),
    );
  if (r.instructions) out.push("", "PREPARACIÓN", r.instructions);
  return out.join("\n");
}

/** Recetario: recetas con categorías flexibles (comida, tragos, salsas…), ingredientes ligados al inventario y preparación. */
export async function recipeBookRoutes(app: FastifyInstance) {
  const { db } = app;

  crud(app, {
    path: "/api/recipe-categories",
    table: "recipe_categories",
    entity: "categoria_receta",
    write: "recipe.manage",
    orderBy: "sort, name",
    shape: { name: z.string().trim().min(1).max(60), sort: z.number().int().min(0).default(0) },
    validate: async (b, rid) => {
      if (typeof b.name === "string") {
        const dup = (await db
          .prepare("SELECT id FROM recipe_categories WHERE lower(name)=lower(?) AND id IS NOT ?")
          .get(b.name, rid)) as { id: string } | undefined;
        if (dup) return `Ya existe una categoría llamada «${b.name}»`;
      }
      return null;
    },
    // Borrar una categoría no borra sus recetas: quedan «sin categoría»
  });

  app.get("/api/recipe-book", { preHandler: app.authorize() }, async (req) => {
    const q = z
      .object({
        categoryId: z.string().optional(),
        q: z.string().trim().max(60).optional(),
        uncategorized: z.coerce.boolean().optional(),
      })
      .parse(req.query);
    const rows = (await db
      .prepare(
        `SELECT r.*, c.name AS category,
                (SELECT COUNT(*) FROM recipe_book_items WHERE recipe_id=r.id) AS ingredients,
                (SELECT COALESCE(SUM(b.quantity * i.unit_cost_cents),0) FROM recipe_book_items b JOIN inventory_items i ON i.id=b.item_id WHERE b.recipe_id=r.id) AS batch_cost_cents,
                p.name AS product
         FROM recipe_book r LEFT JOIN recipe_categories c ON c.id=r.category_id LEFT JOIN products p ON p.id=r.product_id
         WHERE r.active=1
           AND (? IS NULL OR r.category_id=?)
           AND (? = 0 OR r.category_id IS NULL)
           AND (? IS NULL OR lower(r.name) LIKE '%' || lower(?) || '%')
         ORDER BY COALESCE(c.sort, 999), c.name, r.name`,
      )
      .all(
        q.categoryId ?? null,
        q.categoryId ?? null,
        q.uncategorized ? 1 : 0,
        q.q ?? null,
        q.q ?? null,
      )) as (RecipeRow & { batch_cost_cents: number })[];
    return rows.map((r) => ({
      ...r,
      cost_per_portion_cents: Math.round(r.batch_cost_cents / r.yield),
    }));
  });

  app.get("/api/recipe-book/:id", { preHandler: app.authorize() }, async (req) => {
    const { id: rid } = id.parse(req.params);
    const r = (await db
      .prepare(
        "SELECT r.*, c.name AS category, p.name AS product FROM recipe_book r LEFT JOIN recipe_categories c ON c.id=r.category_id LEFT JOIN products p ON p.id=r.product_id WHERE r.id=?",
      )
      .get(rid)) as (RecipeRow & { category: string | null; product: string | null }) | undefined;
    if (!r) throw new HttpError(404, "no_encontrado");
    const ing = await ingredientsOf(db, rid);
    const batch = batchCost(ing);
    return {
      ...r,
      ingredients: ing,
      batch_cost_cents: Math.round(batch),
      cost_per_portion_cents: Math.round(batch / r.yield),
    };
  });

  const shape = z.object({
    name: z.string().trim().min(1).max(80),
    category_id: z.string().nullable().optional(),
    description: z.string().max(400).nullable().optional(),
    instructions: z.string().max(6000).nullable().optional(),
    yield: z.number().positive().max(10000).default(1),
    yield_unit: z.string().trim().min(1).max(20).default("porciones"),
    prep_minutes: z.number().int().min(0).max(1440).nullable().optional(),
    product_id: z.string().nullable().optional(),
    ingredients: z
      .array(
        z.object({
          itemId: z.string().nullable().optional(),
          name: z.string().trim().max(80).optional(),
          quantity: z.number().positive().max(1_000_000),
          unit: z.string().trim().max(12).nullable().optional(),
          note: z.string().max(120).nullable().optional(),
        }),
      )
      .max(80)
      .optional(),
  });

  async function checkRefs(b: { category_id?: string | null; product_id?: string | null }) {
    if (
      b.category_id &&
      !(await db.prepare("SELECT 1 FROM recipe_categories WHERE id=?").get(b.category_id))
    )
      throw new HttpError(400, "validacion", "La categoría no existe");
    if (b.product_id && !(await db.prepare("SELECT 1 FROM products WHERE id=?").get(b.product_id)))
      throw new HttpError(400, "validacion", "El producto no existe");
  }
  async function writeIngredients(
    recipeId: string,
    lines: NonNullable<z.infer<typeof shape>["ingredients"]>,
  ) {
    await db.prepare("DELETE FROM recipe_book_items WHERE recipe_id=?").run(recipeId);
    for (const [i, l] of lines.entries()) {
      let name = l.name ?? "";
      let unit = l.unit ?? null;
      if (l.itemId) {
        const it = (await db
          .prepare("SELECT name, unit FROM inventory_items WHERE id=?")
          .get(l.itemId)) as { name: string; unit: string } | undefined;
        if (!it) throw new HttpError(400, "validacion", "Un insumo de la receta no existe");
        name = it.name;
        unit = unit ?? it.unit;
      }
      if (!name.trim())
        throw new HttpError(400, "validacion", "Cada ingrediente necesita un nombre o un insumo");
      await db
        .prepare(
          "INSERT INTO recipe_book_items (id,recipe_id,item_id,name,quantity,unit,note,sort) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(newId(), recipeId, l.itemId ?? null, name.trim(), l.quantity, unit, l.note ?? null, i);
    }
  }
  const dupName = async (name: string, exceptId: string | null) => {
    const d = await db
      .prepare("SELECT id FROM recipe_book WHERE lower(name)=lower(?) AND active=1 AND id IS NOT ?")
      .get(name, exceptId);
    if (d) throw new HttpError(409, "receta_duplicada", `Ya existe una receta llamada «${name}»`);
  };

  app.post(
    "/api/recipe-book",
    { preHandler: app.authorize("recipe.manage") },
    async (req, reply) => {
      const b = shape.parse(req.body);
      await checkRefs(b);
      await dupName(b.name, null);
      const rid = newId();
      const now = Date.now();
      await db.transaction(async () => {
        await db
          .prepare(
            "INSERT INTO recipe_book (id,name,category_id,description,instructions,yield,yield_unit,prep_minutes,product_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            rid,
            b.name,
            b.category_id ?? null,
            b.description ?? null,
            b.instructions ?? null,
            b.yield,
            b.yield_unit,
            b.prep_minutes ?? null,
            b.product_id ?? null,
            req.user.sub,
            now,
            now,
          );
        if (b.ingredients) await writeIngredients(rid, b.ingredients);
      })();
      await audit(db, req.user.sub, "crear_receta", "recipe_book", rid, { name: b.name });
      return reply.code(201).send({ id: rid });
    },
  );

  app.patch("/api/recipe-book/:id", { preHandler: app.authorize("recipe.manage") }, async (req) => {
    const { id: rid } = id.parse(req.params);
    const b = shape.partial().parse(req.body);
    if (!(await db.prepare("SELECT 1 FROM recipe_book WHERE id=? AND active=1").get(rid)))
      throw new HttpError(404, "no_encontrado");
    await checkRefs(b);
    if (b.name) await dupName(b.name, rid);
    await db.transaction(async () => {
      for (const k of [
        "name",
        "category_id",
        "description",
        "instructions",
        "yield",
        "yield_unit",
        "prep_minutes",
        "product_id",
      ] as const) {
        if (b[k] !== undefined)
          await db
            .prepare(`UPDATE recipe_book SET ${k}=? WHERE id=?`)
            .run(b[k] as string | number | null, rid);
      }
      await db.prepare("UPDATE recipe_book SET updated_at=? WHERE id=?").run(Date.now(), rid);
      if (b.ingredients) await writeIngredients(rid, b.ingredients);
    })();
    await audit(db, req.user.sub, "editar_receta_libro", "recipe_book", rid, {
      campos: Object.keys(b),
    });
    return { ok: true };
  });

  app.delete(
    "/api/recipe-book/:id",
    { preHandler: app.authorize("recipe.manage") },
    async (req) => {
      const { id: rid } = id.parse(req.params);
      const r = await db
        .prepare("UPDATE recipe_book SET active=0, updated_at=? WHERE id=? AND active=1")
        .run(Date.now(), rid);
      if (r.changes === 0) throw new HttpError(404, "no_encontrado");
      await audit(db, req.user.sub, "borrar_receta", "recipe_book", rid);
      return { ok: true };
    },
  );

  app.get("/api/recipe-book/:id/text", { preHandler: app.authorize() }, async (req, reply) => {
    const { id: rid } = id.parse(req.params);
    const q = z
      .object({ portions: z.coerce.number().positive().max(100000).optional() })
      .parse(req.query);
    return reply
      .header("content-type", "text/plain; charset=utf-8")
      .send(await recipeText(db, rid, q.portions));
  });

  /**
   * Usa esta receta para descontar inventario: copia sus ingredientes (por porción) a la receta del producto ligado,
   * de modo que cada venta del platillo o trago baje las existencias.
   */
  app.post(
    "/api/recipe-book/:id/apply-to-product",
    { preHandler: app.authorize("recipe.manage") },
    async (req) => {
      const { id: rid } = id.parse(req.params);
      const { productId } = z.object({ productId: z.string().optional() }).parse(req.body ?? {});
      const r = (await db
        .prepare("SELECT yield, product_id FROM recipe_book WHERE id=? AND active=1")
        .get(rid)) as { yield: number; product_id: string | null } | undefined;
      if (!r) throw new HttpError(404, "no_encontrado");
      const pid = productId ?? r.product_id;
      if (!pid) throw new HttpError(400, "sin_producto", "Liga la receta a un producto del menú");
      if (!(await db.prepare("SELECT 1 FROM products WHERE id=?").get(pid)))
        throw new HttpError(404, "producto_no_encontrado");
      const lines = (await ingredientsOf(db, rid)).filter((l) => l.item_id);
      if (lines.length === 0)
        throw new HttpError(409, "sin_insumos", "Ningún ingrediente está ligado al inventario");
      await db.transaction(async () => {
        await db.prepare("DELETE FROM recipe_lines WHERE product_id=?").run(pid);
        // Si dos renglones usan el mismo insumo se suman (la receta del producto tiene un renglón por insumo)
        const sums = new Map<string, number>();
        for (const l of lines)
          sums.set(l.item_id!, (sums.get(l.item_id!) ?? 0) + l.quantity / r.yield);
        for (const [itemId, qty] of sums)
          await db
            .prepare("INSERT INTO recipe_lines (product_id,item_id,quantity) VALUES (?,?,?)")
            .run(pid, itemId, Math.max(0.0001, round2(qty * 10000) / 10000));
        await db.prepare("UPDATE recipe_book SET product_id=? WHERE id=?").run(pid, rid);
      })();
      await audit(db, req.user.sub, "receta_a_producto", "recipe_book", rid, {
        productId: pid,
        insumos: lines.length,
      });
      return { ok: true, items: lines.length };
    },
  );
}
