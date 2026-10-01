import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, newId, type Db } from "../db";
import { HttpError } from "../domain";
import { applyMovement } from "../inventory";
import { crud } from "./crud";

const id = z.object({ id: z.string() });

export interface ReorderRow {
  itemId: string;
  name: string;
  unit: string;
  stock: number;
  min_stock: number;
  max_stock: number | null;
  /** Cuánto pedir para llegar al máximo (o al doble del mínimo si no hay máximo). */
  suggested: number;
  level: "agotado" | "bajo";
  area_id: string | null;
  area: string | null;
  category_id: string | null;
  category: string | null;
  supplier_id: string | null;
  supplier: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Insumos que llegaron a su mínimo: es el momento de pedir. Sin mínimo definido no hay aviso. */
export async function reorderRows(db: Db, f: { areaId?: string | null; categoryId?: string | null } = {}): Promise<ReorderRow[]> {
  const rows = await db
      .prepare(
        `SELECT i.id, i.name, i.unit, i.stock, i.min_stock, i.max_stock, i.area_id, i.category_id, i.supplier_id,
              a.name AS area, c.name AS category, s.name AS supplier
       FROM inventory_items i
       LEFT JOIN inventory_areas a ON a.id=i.area_id
       LEFT JOIN inventory_categories c ON c.id=i.category_id
       LEFT JOIN suppliers s ON s.id=i.supplier_id
       WHERE i.active=1 AND i.min_stock>0 AND i.stock<=i.min_stock
         AND (? IS NULL OR i.area_id=?) AND (? IS NULL OR i.category_id=?)
       ORDER BY COALESCE(a.sort, 999), a.name, COALESCE(c.sort, 999), c.name, i.name`,
      )
      .all(f.areaId ?? null, f.areaId ?? null, f.categoryId ?? null, f.categoryId ?? null) as {
    id: string; name: string; unit: string; stock: number; min_stock: number; max_stock: number | null;
    area_id: string | null; category_id: string | null; supplier_id: string | null; area: string | null; category: string | null; supplier: string | null;
  }[];
  return rows.map((r) => {
    const target = r.max_stock && r.max_stock > r.min_stock ? r.max_stock : r.min_stock * 2;
    let qty = Math.max(target - Math.max(r.stock, 0), r.min_stock - r.stock, 0);
    qty = r.unit === "pza" ? Math.ceil(qty) : round2(qty);
    if (qty <= 0) qty = r.unit === "pza" ? 1 : round2(r.min_stock);
    return {
      itemId: r.id, name: r.name, unit: r.unit, stock: r.stock, min_stock: r.min_stock, max_stock: r.max_stock, suggested: qty,
      level: r.stock <= 0 ? "agotado" : "bajo",
      area_id: r.area_id, area: r.area, category_id: r.category_id, category: r.category, supplier_id: r.supplier_id, supplier: r.supplier,
    };
  });
}

interface ListLine {
  id: string; item_id: string | null; name: string; unit: string | null; quantity: number; checked: number; note: string | null;
  area: string | null; category: string | null; supplier: string | null; stock: number | null; min_stock: number | null;
}

const linesOf = async (db: Db, listId: string) =>
  await db
        .prepare(
          `SELECT l.id, l.item_id, l.name, l.unit, l.quantity, l.checked, l.note,
              a.name AS area, c.name AS category, s.name AS supplier, i.stock, i.min_stock
       FROM shopping_list_items l
       LEFT JOIN inventory_items i ON i.id=l.item_id
       LEFT JOIN inventory_areas a ON a.id=i.area_id
       LEFT JOIN inventory_categories c ON c.id=i.category_id
       LEFT JOIN suppliers s ON s.id=i.supplier_id
       WHERE l.list_id=?
       ORDER BY l.checked, COALESCE(a.sort, 999), a.name, COALESCE(c.sort, 999), c.name, l.name`,
        )
        .all(listId) as ListLine[];

const establishment = async (db: Db) => (await db.prepare("SELECT value FROM settings WHERE key='establishment_name'").get() as { value: string } | undefined)?.value ?? "Restaurante";

const qtyText = (n: number) => (Math.round(n * 100) / 100).toString();

/** Texto listo para pegar en WhatsApp o imprimir, agrupado por área y categoría. */
export async function listText(db: Db, listId: string): Promise<string> {
  const list = await db.prepare("SELECT * FROM shopping_lists WHERE id=?").get(listId) as { name: string; notes: string | null; created_at: number } | undefined;
  if (!list) throw new HttpError(404, "no_encontrado");
  const lines = await linesOf(db, listId);
  const out = [`LISTA DE COMPRAS · ${await establishment(db)}`, list.name, new Date(list.created_at).toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long", year: "numeric" }), ""];
  let group = "";
  for (const l of lines) {
    const g = [l.area, l.category].filter(Boolean).join(" › ") || "Otros";
    if (g !== group) { if (group) out.push(""); out.push(`— ${g} —`); group = g; }
    out.push(`${l.checked ? "[x]" : "[ ]"} ${l.name}: ${qtyText(l.quantity)} ${l.unit ?? ""}`.trimEnd() + (l.note ? ` (${l.note})` : "") + (l.supplier ? ` · ${l.supplier}` : ""));
  }
  if (list.notes) out.push("", `Notas: ${list.notes}`);
  out.push("", `${lines.length} artículo(s)`);
  return out.join("\n");
}

/** Áreas, categorías, aviso de reorden y listas de compras (con enlace para compartir). */
export async function shoppingRoutes(app: FastifyInstance) {
  const { db, hub } = app;

  // ---------- Áreas y categorías de inventario (las crea el usuario) ----------
  crud(app, {
    path: "/api/inventory/areas", table: "inventory_areas", entity: "area_inventario", write: "inventory.modify", read: "inventory.view", orderBy: "sort, name",
    shape: { name: z.string().trim().min(1).max(60), sort: z.number().int().min(0).default(0) },
    validate: async (b, rid) => {
      if (typeof b.name === "string") {
        const dup = await db.prepare("SELECT id FROM inventory_areas WHERE lower(name)=lower(?) AND id IS NOT ?").get(b.name, rid) as { id: string } | undefined;
        if (dup) return `Ya existe un área llamada «${b.name}»`;
      }
      return null;
    },
    canDelete: async (rid) => {
      const n = (await db.prepare("SELECT COUNT(*) c FROM inventory_items WHERE area_id=?").get(rid) as { c: number }).c;
      return n > 0 ? `El área tiene ${n} insumo(s): muévelos a otra antes de borrarla` : null;
    },
  });

  crud(app, {
    path: "/api/inventory/categories", table: "inventory_categories", entity: "categoria_inventario", write: "inventory.modify", read: "inventory.view", orderBy: "sort, name",
    shape: { area_id: z.string(), name: z.string().trim().min(1).max(60), sort: z.number().int().min(0).default(0) },
    validate: async (b, rid) => {
      const cur = rid ? (await db.prepare("SELECT area_id, name FROM inventory_categories WHERE id=?").get(rid) as { area_id: string; name: string } | undefined) : undefined;
      const area = (b.area_id as string | undefined) ?? cur?.area_id;
      const name = (b.name as string | undefined) ?? cur?.name;
      if (area && !await db.prepare("SELECT 1 FROM inventory_areas WHERE id=?").get(area)) return "El área no existe";
      if (area && name) {
        const dup = await db.prepare("SELECT id FROM inventory_categories WHERE area_id=? AND lower(name)=lower(?) AND id IS NOT ?").get(area, name, rid) as { id: string } | undefined;
        if (dup) return `Ya existe «${name}» en esa área`;
      }
      if (rid && b.area_id && cur && b.area_id !== cur.area_id && (await db.prepare("SELECT COUNT(*) c FROM inventory_items WHERE category_id=?").get(rid) as { c: number }).c > 0) {
        return "La categoría tiene insumos: no se puede cambiar de área";
      }
      return null;
    },
    canDelete: async (rid) => {
      const n = (await db.prepare("SELECT COUNT(*) c FROM inventory_items WHERE category_id=?").get(rid) as { c: number }).c;
      return n > 0 ? `La categoría tiene ${n} insumo(s): muévelos a otra antes de borrarla` : null;
    },
  });

  // ---------- Cuándo pedir ----------
  app.get("/api/inventory/reorder", { preHandler: app.authorize("inventory.view") }, async (req) => {
    const q = z.object({ areaId: z.string().optional(), categoryId: z.string().optional() }).parse(req.query);
    return reorderRows(db, q);
  });

  // ---------- Listas de compras ----------
  const listRow = async (listId: string) => {
    const l = await db.prepare("SELECT * FROM shopping_lists WHERE id=?").get(listId) as { id: string; status: string } | undefined;
    if (!l) throw new HttpError(404, "no_encontrado");
    return l;
  };
  const editable = async (listId: string) => {
    const l = await listRow(listId);
    if (l.status === "comprada" || l.status === "archivada") throw new HttpError(409, "lista_cerrada", "La lista ya está cerrada");
    return l;
  };
  const touch = (listId: string) => hub.emit({ type: "shopping.updated", listId });

  async function addLine(listId: string, l: { itemId?: string | null; name?: string; unit?: string | null; quantity: number; note?: string | null }) {
    let name = l.name ?? "";
    let unit = l.unit ?? null;
    if (l.itemId) {
      const it = await db.prepare("SELECT name, unit FROM inventory_items WHERE id=?").get(l.itemId) as { name: string; unit: string } | undefined;
      if (!it) throw new HttpError(404, "insumo_no_encontrado");
      name = it.name;
      unit = unit ?? it.unit;
      const same = await db.prepare("SELECT id, quantity FROM shopping_list_items WHERE list_id=? AND item_id=?").get(listId, l.itemId) as { id: string; quantity: number } | undefined;
      if (same) {
        await db.prepare("UPDATE shopping_list_items SET quantity=?, checked=0 WHERE id=?").run(round2(same.quantity + l.quantity), same.id);
        return same.id;
      }
    }
    if (!name.trim()) throw new HttpError(400, "validacion", "Escribe el nombre del artículo");
    const lid = newId();
    await db.prepare("INSERT INTO shopping_list_items (id,list_id,item_id,name,unit,quantity,note,sort) VALUES (?,?,?,?,?,?,?,?)").run(
            lid, listId, l.itemId ?? null, name.trim(), unit, l.quantity, l.note ?? null, (await db.prepare("SELECT COUNT(*) c FROM shopping_list_items WHERE list_id=?").get(listId) as { c: number }).c,
          );
    return lid;
  }

  app.get("/api/shopping-lists", { preHandler: app.authorize("inventory.view") }, async () =>
    db
      .prepare(
        `SELECT l.id, l.name, l.kind, l.status, l.share_token, l.created_at, l.closed_at,
                (SELECT COUNT(*) FROM shopping_list_items WHERE list_id=l.id) AS items,
                (SELECT COUNT(*) FROM shopping_list_items WHERE list_id=l.id AND checked=1) AS checked
         FROM shopping_lists l ORDER BY (l.status IN ('comprada','archivada')), l.created_at DESC`,
      )
      .all(),
  );

  app.post("/api/shopping-lists", { preHandler: app.authorize("inventory.modify") }, async (req, reply) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        /** true: arma la lista con lo que ya llegó al mínimo (se puede acotar por área o categoría). */
        auto: z.boolean().default(false),
        areaId: z.string().optional(),
        categoryId: z.string().optional(),
        notes: z.string().max(500).optional(),
      })
      .parse(req.body ?? {});
    const listId = newId();
    const when = new Date().toLocaleDateString("es-MX", { day: "numeric", month: "short" });
    let added = 0;
    await db.transaction(async () => {
            await db.prepare("INSERT INTO shopping_lists (id,name,kind,notes,created_by,created_at) VALUES (?,?,?,?,?,?)").run(
                      listId, b.name ?? (b.auto ? `Por pedir · ${when}` : `Compras · ${when}`), b.auto ? "auto" : "manual", b.notes ?? null, req.user.sub, Date.now(),
                    );
            if (b.auto) for (const r of await reorderRows(db, b)) { await addLine(listId, { itemId: r.itemId, quantity: r.suggested }); added++; }
          })();
    await audit(db, req.user.sub, "crear_lista_compras", "shopping_list", listId, { auto: b.auto, items: added });
    touch(listId);
    return reply.code(201).send({ id: listId, items: added });
  });

  app.get("/api/shopping-lists/:id", { preHandler: app.authorize("inventory.view") }, async (req) => {
    const { id: listId } = id.parse(req.params);
    const list = await db.prepare("SELECT * FROM shopping_lists WHERE id=?").get(listId);
    if (!list) throw new HttpError(404, "no_encontrado");
    return { ...(list as object), lines: await linesOf(db, listId) };
  });

  app.patch("/api/shopping-lists/:id", { preHandler: app.authorize("inventory.modify") }, async (req) => {
    const { id: listId } = id.parse(req.params);
    const b = z.object({ name: z.string().trim().min(1).max(80).optional(), notes: z.string().max(500).nullable().optional(), status: z.enum(["abierta", "compartida", "archivada"]).optional() }).parse(req.body);
    await listRow(listId);
    if (b.name !== undefined) await db.prepare("UPDATE shopping_lists SET name=? WHERE id=?").run(b.name, listId);
    if (b.notes !== undefined) await db.prepare("UPDATE shopping_lists SET notes=? WHERE id=?").run(b.notes, listId);
    if (b.status !== undefined) await db.prepare("UPDATE shopping_lists SET status=?, closed_at=? WHERE id=?").run(b.status, b.status === "archivada" ? Date.now() : null, listId);
    touch(listId);
    return { ok: true };
  });

  app.delete("/api/shopping-lists/:id", { preHandler: app.authorize("inventory.modify") }, async (req) => {
    const { id: listId } = id.parse(req.params);
    await listRow(listId);
    await db.prepare("DELETE FROM shopping_lists WHERE id=?").run(listId);
    await audit(db, req.user.sub, "borrar_lista_compras", "shopping_list", listId);
    touch(listId);
    return { ok: true };
  });

  const lineBody = z.object({
    itemId: z.string().optional(),
    name: z.string().trim().max(80).optional(),
    unit: z.string().trim().max(12).optional(),
    quantity: z.number().positive().max(100000),
    note: z.string().max(120).optional(),
  });

  app.post("/api/shopping-lists/:id/items", { preHandler: app.authorize("inventory.modify") }, async (req, reply) => {
    const { id: listId } = id.parse(req.params);
    const b = lineBody.parse(req.body);
    await editable(listId);
    if (!b.itemId && !b.name) throw new HttpError(400, "validacion", "Elige un insumo o escribe un nombre");
    const lid = await db.transaction(() => addLine(listId, b))();
    touch(listId);
    return reply.code(201).send({ id: lid });
  });

  app.patch("/api/shopping-lists/:id/items/:lid", { preHandler: app.authorize("inventory.modify") }, async (req) => {
    const p = z.object({ id: z.string(), lid: z.string() }).parse(req.params);
    const b = z.object({ quantity: z.number().positive().max(100000).optional(), checked: z.boolean().optional(), note: z.string().max(120).nullable().optional(), name: z.string().trim().min(1).max(80).optional() }).parse(req.body);
    await editable(p.id);
    const line = await db.prepare("SELECT id FROM shopping_list_items WHERE id=? AND list_id=?").get(p.lid, p.id);
    if (!line) throw new HttpError(404, "no_encontrado");
    if (b.quantity !== undefined) await db.prepare("UPDATE shopping_list_items SET quantity=? WHERE id=?").run(b.quantity, p.lid);
    if (b.checked !== undefined) await db.prepare("UPDATE shopping_list_items SET checked=? WHERE id=?").run(b.checked ? 1 : 0, p.lid);
    if (b.note !== undefined) await db.prepare("UPDATE shopping_list_items SET note=? WHERE id=?").run(b.note, p.lid);
    if (b.name !== undefined) await db.prepare("UPDATE shopping_list_items SET name=? WHERE id=? AND item_id IS NULL").run(b.name, p.lid);
    touch(p.id);
    return { ok: true };
  });

  app.delete("/api/shopping-lists/:id/items/:lid", { preHandler: app.authorize("inventory.modify") }, async (req) => {
    const p = z.object({ id: z.string(), lid: z.string() }).parse(req.params);
    await editable(p.id);
    const r = await db.prepare("DELETE FROM shopping_list_items WHERE id=? AND list_id=?").run(p.lid, p.id);
    if (r.changes === 0) throw new HttpError(404, "no_encontrado");
    touch(p.id);
    return { ok: true };
  });

  /** Agrega a la lista lo que llegó al mínimo desde que se armó (sin tocar lo que ya tiene). */
  app.post("/api/shopping-lists/:id/refresh", { preHandler: app.authorize("inventory.modify") }, async (req) => {
    const { id: listId } = id.parse(req.params);
    await editable(listId);
    let added = 0;
    await db.transaction(async () => {
            for (const r of await reorderRows(db)) {
              if (await db.prepare("SELECT 1 FROM shopping_list_items WHERE list_id=? AND item_id=?").get(listId, r.itemId)) continue;
              await addLine(listId, { itemId: r.itemId, quantity: r.suggested });
              added++;
            }
          })();
    touch(listId);
    return { added };
  });

  app.get("/api/shopping-lists/:id/text", { preHandler: app.authorize("inventory.view") }, async (req, reply) => {
    const { id: listId } = id.parse(req.params);
    return reply.header("content-type", "text/plain; charset=utf-8").send(await listText(db, listId));
  });

  /** Genera (o reutiliza) el enlace público para compartir: quien lo abre ve la lista y marca lo comprado. */
  app.post("/api/shopping-lists/:id/share", { preHandler: app.authorize("inventory.modify") }, async (req) => {
    const { id: listId } = id.parse(req.params);
    const list = await listRow(listId) as { id: string; status: string; share_token?: string | null };
    const full = await db.prepare("SELECT share_token FROM shopping_lists WHERE id=?").get(listId) as { share_token: string | null };
    let token = full.share_token;
    if (!token) {
      token = randomBytes(12).toString("hex");
      await db.prepare("UPDATE shopping_lists SET share_token=? WHERE id=?").run(token, listId);
    }
    if (list.status === "abierta") await db.prepare("UPDATE shopping_lists SET status='compartida' WHERE id=?").run(listId);
    const text = await listText(db, listId);
    await audit(db, req.user.sub, "compartir_lista_compras", "shopping_list", listId);
    touch(listId);
    return { token, path: `/s?t=${token}`, text, whatsapp: `https://wa.me/?text=${encodeURIComponent(text)}` };
  });

  app.post("/api/shopping-lists/:id/unshare", { preHandler: app.authorize("inventory.modify") }, async (req) => {
    const { id: listId } = id.parse(req.params);
    await listRow(listId);
    await db.prepare("UPDATE shopping_lists SET share_token=NULL, status=CASE WHEN status='compartida' THEN 'abierta' ELSE status END WHERE id=?").run(listId);
    touch(listId);
    return { ok: true };
  });

  /** Lo comprado (marcado) entra al inventario como entrada y la lista se cierra. */
  app.post("/api/shopping-lists/:id/receive", { preHandler: app.authorize("inventory.modify") }, async (req) => {
    const { id: listId } = id.parse(req.params);
    await editable(listId);
    const rows = await db.prepare("SELECT id, item_id, quantity, name FROM shopping_list_items WHERE list_id=? AND checked=1").all(listId) as { id: string; item_id: string | null; quantity: number; name: string }[];
    if (rows.length === 0) throw new HttpError(409, "nada_marcado", "Marca primero lo que ya compraste");
    let received = 0;
    await db.transaction(async () => {
            for (const r of rows) if (r.item_id) { await applyMovement(db, r.item_id, "compra", r.quantity, { userId: req.user.sub, ref: listId, reason: "Lista de compras" }); received++; }
            await db.prepare("UPDATE shopping_lists SET status='comprada', closed_at=? WHERE id=?").run(Date.now(), listId);
          })();
    await audit(db, req.user.sub, "recibir_lista_compras", "shopping_list", listId, { received });
    touch(listId);
    return { received, skipped: rows.length - received };
  });

  /** Convierte la lista en órdenes de compra borrador, una por proveedor habitual de cada insumo. */
  app.post("/api/shopping-lists/:id/purchase-orders", { preHandler: app.authorize("purchase.manage") }, async (req, reply) => {
    const { id: listId } = id.parse(req.params);
    await listRow(listId);
    const rows = await db
          .prepare(
            `SELECT l.item_id, l.quantity, l.name, i.supplier_id, i.unit_cost_cents FROM shopping_list_items l
         LEFT JOIN inventory_items i ON i.id=l.item_id WHERE l.list_id=?`,
          )
          .all(listId) as { item_id: string | null; quantity: number; name: string; supplier_id: string | null; unit_cost_cents: number | null }[];
    const bySupplier = new Map<string, typeof rows>();
    const unassigned: string[] = [];
    for (const r of rows) {
      if (!r.item_id || !r.supplier_id) { unassigned.push(r.name); continue; }
      bySupplier.set(r.supplier_id, [...(bySupplier.get(r.supplier_id) ?? []), r]);
    }
    const created: string[] = [];
    await db.transaction(async () => {
            for (const [supplierId, lines] of bySupplier) {
              const po = newId();
              await db.prepare("INSERT INTO purchase_orders (id,supplier_id,notes,created_by,created_at) VALUES (?,?,?,?,?)").run(po, supplierId, `Desde lista de compras`, req.user.sub, Date.now());
              for (const l of lines) await db.prepare("INSERT INTO purchase_lines (id,po_id,item_id,quantity,unit_cost_cents) VALUES (?,?,?,?,?)").run(newId(), po, l.item_id, l.quantity, Math.round(l.unit_cost_cents ?? 0));
              created.push(po);
            }
          })();
    await audit(db, req.user.sub, "lista_a_ordenes_compra", "shopping_list", listId, { ordenes: created.length });
    return reply.code(201).send({ orders: created, unassigned });
  });

  // ---------- Vista pública (quien recibe el enlace) ----------
  const byToken = async (token: string) => {
    const l = await db.prepare("SELECT id, name, notes, status, created_at FROM shopping_lists WHERE share_token=?").get(token) as { id: string; name: string; notes: string | null; status: string; created_at: number } | undefined;
    if (!l) throw new HttpError(404, "no_encontrado", "El enlace ya no es válido");
    return l;
  };

  app.get("/api/shared/shopping/:token", async (req) => {
    const { token } = z.object({ token: z.string().regex(/^[a-f0-9]{24}$/) }).parse(req.params);
    const l = await byToken(token);
    return {
      name: l.name, notes: l.notes, status: l.status, created_at: l.created_at, establishment: await establishment(db),
      lines: (await linesOf(db, l.id)).map((x) => ({ id: x.id, name: x.name, unit: x.unit, quantity: x.quantity, checked: !!x.checked, note: x.note, area: x.area, category: x.category, supplier: x.supplier })),
    };
  });

  app.patch("/api/shared/shopping/:token/items/:lid", async (req) => {
    const p = z.object({ token: z.string().regex(/^[a-f0-9]{24}$/), lid: z.string() }).parse(req.params);
    const { checked } = z.object({ checked: z.boolean() }).parse(req.body);
    const l = await byToken(p.token);
    if (l.status === "comprada" || l.status === "archivada") throw new HttpError(409, "lista_cerrada", "La lista ya está cerrada");
    const r = await db.prepare("UPDATE shopping_list_items SET checked=? WHERE id=? AND list_id=?").run(checked ? 1 : 0, p.lid, l.id);
    if (r.changes === 0) throw new HttpError(404, "no_encontrado");
    touch(l.id);
    return { ok: true };
  });
}
