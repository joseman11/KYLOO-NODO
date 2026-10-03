import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, newId } from "../db";
import { HttpError } from "../domain";
import { alertFor, applyMovement, emitAlerts } from "../inventory";
import { crud } from "./crud";

const id = z.object({ id: z.string() });

/** Inventario, recetas, proveedores y compras (Fase 2). */
export async function inventoryRoutes(app: FastifyInstance) {
  const { db, hub } = app;

  crud(app, {
    path: "/api/inventory/items",
    table: "inventory_items",
    entity: "insumo",
    write: "inventory.modify",
    read: "inventory.view",
    orderBy: "name",
    shape: {
      name: z.string().min(1),
      unit: z.string().min(1),
      min_stock: z.number().min(0).default(0),
      max_stock: z.number().min(0).nullable().optional(),
      unit_cost_cents: z.number().min(0).default(0),
      active: z.boolean().default(true),
      /** Área (Cocina, Barra…), categoría dentro del área (Mariscos, Enlatados…) y proveedor habitual. */
      area_id: z.string().nullable().optional(),
      category_id: z.string().nullable().optional(),
      supplier_id: z.string().nullable().optional(),
    },
    validate: async (b, rid) => {
      if (
        b.max_stock != null &&
        b.min_stock != null &&
        (b.max_stock as number) < (b.min_stock as number)
      )
        return "El máximo no puede ser menor que el mínimo";
      const cur = rid
        ? ((await db
            .prepare(
              "SELECT area_id, category_id, min_stock, max_stock FROM inventory_items WHERE id=?",
            )
            .get(rid)) as
            | {
                area_id: string | null;
                category_id: string | null;
                min_stock: number;
                max_stock: number | null;
              }
            | undefined)
        : undefined;
      const min = (b.min_stock as number | undefined) ?? cur?.min_stock;
      const max = b.max_stock !== undefined ? (b.max_stock as number | null) : cur?.max_stock;
      if (max != null && min != null && max < min)
        return "El máximo no puede ser menor que el mínimo";
      const area = b.area_id !== undefined ? (b.area_id as string | null) : (cur?.area_id ?? null);
      // Al cambiar de área sin elegir categoría nueva, la anterior ya no aplica
      if (
        rid &&
        b.area_id !== undefined &&
        b.category_id === undefined &&
        cur?.category_id &&
        area !== cur.area_id
      )
        b.category_id = null;
      const cat =
        b.category_id !== undefined ? (b.category_id as string | null) : (cur?.category_id ?? null);
      if (area && !(await db.prepare("SELECT 1 FROM inventory_areas WHERE id=?").get(area)))
        return "El área no existe";
      if (
        b.supplier_id &&
        !(await db.prepare("SELECT 1 FROM suppliers WHERE id=?").get(b.supplier_id as string))
      )
        return "El proveedor no existe";
      if (cat) {
        const c = (await db
          .prepare("SELECT area_id FROM inventory_categories WHERE id=?")
          .get(cat)) as { area_id: string } | undefined;
        if (!c) return "La categoría no existe";
        if (c.area_id !== area) return "La categoría no pertenece a esa área";
      }
      return null;
    },
  });

  // Movimientos manuales: entradas, salidas, mermas y ajustes (sec. 38)
  app.post(
    "/api/inventory/movements",
    { preHandler: app.authorize("inventory.modify") },
    async (req, reply) => {
      const b = z
        .object({
          itemId: z.string(),
          kind: z.enum(["entrada", "salida", "merma", "ajuste"]),
          quantity: z.number().refine((n) => n !== 0, "La cantidad no puede ser 0"),
          unit_cost_cents: z.number().min(0).optional(),
          reason: z.string().optional(),
        })
        .parse(req.body);
      if (b.kind !== "ajuste" && b.quantity < 0)
        throw new HttpError(400, "validacion", "La cantidad debe ser positiva");
      if ((b.kind === "merma" || b.kind === "ajuste") && !b.reason)
        throw new HttpError(400, "motivo_requerido", "Indica el motivo");
      const signed = b.kind === "entrada" || b.kind === "ajuste" ? b.quantity : -b.quantity;
      const after = await db.transaction(() =>
        applyMovement(db, b.itemId, b.kind, signed, {
          reason: b.reason,
          userId: req.user.sub,
          unitCostCents: b.kind === "entrada" ? b.unit_cost_cents : undefined,
        }),
      )();
      await audit(db, req.user.sub, `inventario_${b.kind}`, "insumo", b.itemId, {
        quantity: signed,
        reason: b.reason,
      });
      const alert = alertFor(after);
      if (alert) emitAlerts(hub, [alert]);
      return reply.code(201).send({ stock: after.stock });
    },
  );

  app.get(
    "/api/inventory/movements",
    { preHandler: app.authorize("inventory.view") },
    async (req) => {
      const q = z
        .object({
          itemId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        })
        .parse(req.query);
      return db
        .prepare(
          `SELECT m.*, i.name AS item, i.unit FROM inventory_movements m JOIN inventory_items i ON i.id=m.item_id
         ${q.itemId ? "WHERE m.item_id=?" : ""} ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
        )
        .all(...(q.itemId ? [q.itemId, q.limit] : [q.limit]));
    },
  );

  // Inventario físico: compara lo contado con el sistema y genera ajustes
  app.post(
    "/api/inventory/count",
    { preHandler: app.authorize("inventory.modify") },
    async (req) => {
      const b = z
        .object({
          lines: z.array(z.object({ itemId: z.string(), counted: z.number().min(0) })).min(1),
        })
        .parse(req.body);
      const diffs: { itemId: string; difference: number }[] = [];
      await db.transaction(async () => {
        for (const l of b.lines) {
          const cur = (await db
            .prepare("SELECT stock FROM inventory_items WHERE id=?")
            .get(l.itemId)) as { stock: number } | undefined;
          if (!cur) throw new HttpError(404, "insumo_no_encontrado");
          const diff = Math.round((l.counted - cur.stock) * 1000) / 1000;
          if (diff !== 0) {
            await applyMovement(db, l.itemId, "ajuste", diff, {
              reason: "Inventario físico",
              userId: req.user.sub,
            });
            diffs.push({ itemId: l.itemId, difference: diff });
          }
        }
      })();
      await audit(db, req.user.sub, "inventario_fisico", "insumo", undefined, {
        ajustes: diffs.length,
      });
      return { adjusted: diffs };
    },
  );

  // Alertas: stock bajo, agotado, negativo (sec. 40)
  app.get("/api/inventory/alerts", { preHandler: app.authorize("inventory.view") }, async () => {
    const rows = (await db
      .prepare("SELECT id, name, stock, min_stock FROM inventory_items WHERE active=1")
      .all()) as { id: string; name: string; stock: number; min_stock: number }[];
    return rows.map(alertFor).filter((a) => a !== null);
  });

  // ---------- Recetas ----------
  app.get("/api/recipes/:id", { preHandler: app.authorize("inventory.view") }, async (req) => {
    const { id: productId } = id.parse(req.params);
    return db
      .prepare(
        "SELECT l.item_id, l.quantity, i.name, i.unit FROM recipe_lines l JOIN inventory_items i ON i.id=l.item_id WHERE l.product_id=? ORDER BY i.name",
      )
      .all(productId);
  });

  app.put("/api/recipes/:id", { preHandler: app.authorize("inventory.modify") }, async (req) => {
    const { id: productId } = id.parse(req.params);
    const b = z
      .object({ lines: z.array(z.object({ itemId: z.string(), quantity: z.number().positive() })) })
      .parse(req.body);
    if (!(await db.prepare("SELECT 1 FROM products WHERE id=?").get(productId)))
      throw new HttpError(404, "no_encontrado");
    await db.transaction(async () => {
      await db.prepare("DELETE FROM recipe_lines WHERE product_id=?").run(productId);
      for (const l of b.lines)
        await db
          .prepare("INSERT INTO recipe_lines (product_id,item_id,quantity) VALUES (?,?,?)")
          .run(productId, l.itemId, l.quantity);
    })();
    await audit(db, req.user.sub, "editar_receta", "product", productId, { lines: b.lines.length });
    return { ok: true };
  });

  // Costo y margen por producto según receta y costo promedio actual
  app.get("/api/inventory/costs", { preHandler: app.authorize("inventory.view") }, async () => {
    const rows = (await db
      .prepare(
        `SELECT p.id, p.name, p.price_cents, ROUND(SUM(l.quantity * i.unit_cost_cents)) AS cost_cents
         FROM products p JOIN recipe_lines l ON l.product_id=p.id JOIN inventory_items i ON i.id=l.item_id
         GROUP BY p.id ORDER BY p.name`,
      )
      .all()) as { id: string; name: string; price_cents: number; cost_cents: number }[];
    return rows.map((r) => ({
      ...r,
      margin_cents: r.price_cents - r.cost_cents,
      margin_pct: r.price_cents
        ? Math.round(((r.price_cents - r.cost_cents) / r.price_cents) * 1000) / 10
        : 0,
    }));
  });

  // ---------- Proveedores ----------
  crud(app, {
    path: "/api/suppliers",
    table: "suppliers",
    entity: "proveedor",
    write: "purchase.manage",
    read: "inventory.view",
    orderBy: "name",
    shape: {
      name: z.string().min(1),
      rfc: z.string().nullable().optional(),
      contact: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
      address: z.string().nullable().optional(),
      active: z.boolean().default(true),
    },
  });

  // ---------- Compras (sec. 42) ----------
  app.post(
    "/api/purchase-orders",
    { preHandler: app.authorize("purchase.manage") },
    async (req, reply) => {
      const b = z
        .object({
          supplierId: z.string(),
          notes: z.string().optional(),
          lines: z
            .array(
              z.object({
                itemId: z.string(),
                quantity: z.number().positive(),
                unit_cost_cents: z.number().min(0),
              }),
            )
            .min(1),
        })
        .parse(req.body);
      const poId = newId();
      await db.transaction(async () => {
        await db
          .prepare(
            "INSERT INTO purchase_orders (id,supplier_id,notes,created_by,created_at) VALUES (?,?,?,?,?)",
          )
          .run(poId, b.supplierId, b.notes ?? null, req.user.sub, Date.now());
        for (const l of b.lines)
          await db
            .prepare(
              "INSERT INTO purchase_lines (id,po_id,item_id,quantity,unit_cost_cents) VALUES (?,?,?,?,?)",
            )
            .run(newId(), poId, l.itemId, l.quantity, l.unit_cost_cents);
      })();
      await audit(db, req.user.sub, "crear", "orden_compra", poId, { supplierId: b.supplierId });
      return reply.code(201).send({ id: poId });
    },
  );

  app.get("/api/purchase-orders", { preHandler: app.authorize("inventory.view") }, async (req) => {
    const q = z.object({ supplierId: z.string().optional() }).parse(req.query);
    const pos = (await db
      .prepare(
        `SELECT po.*, s.name AS supplier FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id ${q.supplierId ? "WHERE po.supplier_id=?" : ""} ORDER BY po.created_at DESC`,
      )
      .all(...(q.supplierId ? [q.supplierId] : []))) as { id: string }[];
    return Promise.all(
      pos.map(async (po) => {
        const lines = (await db
          .prepare(
            "SELECT l.*, i.name AS item, i.unit FROM purchase_lines l JOIN inventory_items i ON i.id=l.item_id WHERE l.po_id=?",
          )
          .all(po.id)) as { quantity: number; unit_cost_cents: number }[];
        return {
          ...po,
          lines,
          total_cents: Math.round(lines.reduce((s, l) => s + l.quantity * l.unit_cost_cents, 0)),
        };
      }),
    );
  });

  const poStatus = async (poId: string) => {
    const po = (await db.prepare("SELECT * FROM purchase_orders WHERE id=?").get(poId)) as
      | { id: string; status: string }
      | undefined;
    if (!po) throw new HttpError(404, "no_encontrado");
    return po;
  };

  app.post(
    "/api/purchase-orders/:id/send",
    { preHandler: app.authorize("purchase.manage") },
    async (req) => {
      const { id: poId } = id.parse(req.params);
      const po = await poStatus(poId);
      if (po.status !== "borrador") throw new HttpError(409, "transicion_invalida", po.status);
      await db.prepare("UPDATE purchase_orders SET status='enviada' WHERE id=?").run(poId);
      await audit(db, req.user.sub, "enviar", "orden_compra", poId);
      return { ok: true };
    },
  );

  app.post(
    "/api/purchase-orders/:id/cancel",
    { preHandler: app.authorize("purchase.manage") },
    async (req) => {
      const { id: poId } = id.parse(req.params);
      const po = await poStatus(poId);
      if (po.status === "recibida") throw new HttpError(409, "ya_recibida");
      await db.prepare("UPDATE purchase_orders SET status='cancelada' WHERE id=?").run(poId);
      await audit(db, req.user.sub, "cancelar", "orden_compra", poId);
      return { ok: true };
    },
  );

  // Recepción: suma existencias y recalcula el costo promedio ponderado
  app.post(
    "/api/purchase-orders/:id/receive",
    { preHandler: app.authorize("purchase.manage") },
    async (req) => {
      const { id: poId } = id.parse(req.params);
      const b = z.object({ invoice_ref: z.string().optional() }).parse(req.body ?? {});
      const po = await poStatus(poId);
      if (po.status === "recibida" || po.status === "cancelada")
        throw new HttpError(409, "transicion_invalida", po.status);
      const lines = (await db
        .prepare("SELECT item_id, quantity, unit_cost_cents FROM purchase_lines WHERE po_id=?")
        .all(poId)) as { item_id: string; quantity: number; unit_cost_cents: number }[];
      await db.transaction(async () => {
        for (const l of lines)
          await applyMovement(db, l.item_id, "compra", l.quantity, {
            userId: req.user.sub,
            ref: poId,
            unitCostCents: l.unit_cost_cents,
            reason: "Recepción de compra",
          });
        await db
          .prepare(
            "UPDATE purchase_orders SET status='recibida', received_at=?, invoice_ref=? WHERE id=?",
          )
          .run(Date.now(), b.invoice_ref ?? null, poId);
      })();
      await audit(db, req.user.sub, "recibir", "orden_compra", poId, {
        invoice_ref: b.invoice_ref,
      });
      return { ok: true, received: lines.length };
    },
  );
}
