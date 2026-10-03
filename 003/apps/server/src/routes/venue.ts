import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, newId } from "../db";
import { HttpError } from "../domain";
import { crud } from "./crud";

/** Estructura del local: áreas → subáreas → estaciones, impresoras, zonas y mesas. */
export async function venueRoutes(app: FastifyInstance) {
  const { db } = app;
  const count = async (sql: string, id: string) =>
    ((await db.prepare(sql).get(id)) as { c: number }).c;

  crud(app, {
    path: "/api/areas",
    table: "areas",
    entity: "area",
    write: "venue.manage",
    shape: { name: z.string().min(1), kind: z.enum(["servicio", "produccion", "despacho"]) },
    canDelete: async (id) => {
      const n = await count(
        "SELECT COUNT(*) c FROM stations s JOIN subareas sa ON sa.id=s.subarea_id WHERE sa.area_id=?",
        id,
      );
      return n ? `El área tiene ${n} estación(es): elimínalas o muévelas primero` : null;
    },
  });
  crud(app, {
    path: "/api/subareas",
    table: "subareas",
    entity: "subarea",
    write: "venue.manage",
    shape: { area_id: z.string(), name: z.string().min(1) },
    canDelete: async (id) =>
      (await count("SELECT COUNT(*) c FROM stations WHERE subarea_id=?", id))
        ? "La subárea tiene estaciones"
        : null,
  });

  // Alta rápida de estación dentro de un área (crea la subárea con el mismo nombre si hace falta)
  app.post(
    "/api/areas/:id/stations",
    { preHandler: app.authorize("venue.manage") },
    async (req, reply) => {
      const { id: areaId } = z.object({ id: z.string() }).parse(req.params);
      const b = z
        .object({
          name: z.string().trim().min(1),
          primary_printer_id: z.string().nullable().optional(),
          secondary_printer_id: z.string().nullable().optional(),
          has_kds: z.boolean().default(false),
        })
        .parse(req.body);
      if (!(await db.prepare("SELECT 1 FROM areas WHERE id=?").get(areaId)))
        throw new HttpError(404, "no_encontrado");
      const dup = await db
        .prepare(
          "SELECT 1 FROM stations s JOIN subareas sa ON sa.id=s.subarea_id WHERE sa.area_id=? AND LOWER(s.name)=LOWER(?)",
        )
        .get(areaId, b.name);
      if (dup)
        throw new HttpError(
          409,
          "estacion_repetida",
          "Ya existe una estación con ese nombre en el área",
        );
      const stationId = newId();
      await db.transaction(async () => {
        let sub = (await db
          .prepare("SELECT id FROM subareas WHERE area_id=? AND LOWER(name)=LOWER(?)")
          .get(areaId, b.name)) as { id: string } | undefined;
        if (!sub) {
          sub = { id: newId() };
          await db
            .prepare("INSERT INTO subareas (id,area_id,name) VALUES (?,?,?)")
            .run(sub.id, areaId, b.name);
        }
        await db
          .prepare(
            "INSERT INTO stations (id,subarea_id,name,primary_printer_id,secondary_printer_id,has_kds) VALUES (?,?,?,?,?,?)",
          )
          .run(
            stationId,
            sub.id,
            b.name,
            b.primary_printer_id ?? null,
            b.secondary_printer_id ?? null,
            b.has_kds ? 1 : 0,
          );
      })();
      await audit(db, req.user.sub, "crear", "station", stationId, { areaId, name: b.name });
      return reply.code(201).send({ id: stationId });
    },
  );
  crud(app, {
    path: "/api/printers",
    table: "printers",
    entity: "printer",
    write: "printer.manage",
    shape: {
      name: z.string().min(1),
      kind: z.enum(["cocina", "bar", "caja", "recepcion", "admin"]),
      host: z.string().nullable().optional(),
      port: z.number().int().min(1).max(65535).default(9100),
      paper_width: z.union([z.literal(58), z.literal(80)]).default(80),
      copies: z.number().int().min(1).max(5).default(1),
      auto_cut: z.boolean().default(true),
      has_drawer: z.boolean().default(false),
      drawer_pin: z.union([z.literal(0), z.literal(1)]).default(0),
      active: z.boolean().default(true),
    },
  });
  crud(app, {
    path: "/api/stations",
    table: "stations",
    entity: "station",
    write: "venue.manage",
    canDelete: async (id) => {
      const n =
        (await count("SELECT COUNT(*) c FROM product_routes WHERE station_id=?", id)) +
        (await count("SELECT COUNT(*) c FROM category_routes WHERE station_id=?", id));
      return n
        ? `A esta estación se envían ${n} producto(s)/categoría(s): cámbialos de destino primero`
        : null;
    },
    shape: {
      subarea_id: z.string(),
      name: z.string().min(1),
      primary_printer_id: z.string().nullable().optional(),
      secondary_printer_id: z.string().nullable().optional(),
      has_kds: z.boolean().default(false),
    },
  });
  crud(app, {
    // Áreas de servicio (Salón, Terraza, Barra…). El prefijo (T, S, B…) nombra sus mesas: T1, T2…
    path: "/api/zones",
    table: "zones",
    entity: "zone",
    write: "venue.manage",
    orderBy: "sort, name",
    shape: {
      name: z.string().trim().min(1).max(40),
      prefix: z.string().trim().max(4).default(""),
      sort: z.number().int().default(0),
    },
    validate: async (b, zid) => {
      const dup = await db
        .prepare("SELECT 1 FROM zones WHERE LOWER(name)=LOWER(?) AND id IS NOT ?")
        .get(String(b.name ?? ""), zid);
      return b.name && dup ? "Ya existe un área con ese nombre" : null;
    },
    canDelete: async (zid) => {
      const n = await count("SELECT COUNT(*) c FROM tables_ WHERE zone_id=?", zid);
      return n ? `El área tiene ${n} mesa(s): muévelas a otra área o elimínalas primero` : null;
    },
  });

  // Alta de varias mesas de golpe en un área: T1…T6 (usa el prefijo del área y sigue la numeración)
  app.post(
    "/api/tables/bulk",
    { preHandler: app.authorize("venue.manage") },
    async (req, reply) => {
      const b = z
        .object({
          zone_id: z.string(),
          count: z.number().int().min(1).max(60),
          start: z.number().int().min(1).max(9999).optional(),
          capacity: z.number().int().min(1).max(50).default(4),
        })
        .parse(req.body);
      const zone = (await db.prepare("SELECT id, prefix FROM zones WHERE id=?").get(b.zone_id)) as
        | { id: string; prefix: string }
        | undefined;
      if (!zone) throw new HttpError(404, "no_encontrado", "El área no existe");
      // Por omisión continúa después de la última mesa del área
      const last = (
        (await db.prepare("SELECT number FROM tables_ WHERE zone_id=?").all(zone.id)) as {
          number: string;
        }[]
      )
        .map((t) => parseInt(t.number.slice(zone.prefix.length), 10))
        .filter((n) => Number.isFinite(n))
        .reduce((m, n) => Math.max(m, n), 0);
      const start = b.start ?? last + 1;
      const created: string[] = [];
      const skipped: string[] = [];
      await db.transaction(async () => {
        for (let i = 0; i < b.count; i++) {
          const number = `${zone.prefix}${start + i}`;
          if (await db.prepare("SELECT 1 FROM tables_ WHERE number=?").get(number)) {
            skipped.push(number);
            continue;
          }
          await db
            .prepare("INSERT INTO tables_ (id,zone_id,number,capacity) VALUES (?,?,?,?)")
            .run(newId(), zone.id, number, b.capacity);
          created.push(number);
        }
      })();
      await audit(db, req.user.sub, "crear_mesas", "zone", zone.id, {
        created: created.length,
        skipped: skipped.length,
      });
      return reply.code(201).send({ created, skipped });
    },
  );

  // Mesa fuera de servicio (no se puede abrir) y de vuelta a disponible; nunca con una cuenta abierta
  app.post(
    "/api/tables/:id/service",
    { preHandler: app.authorize("venue.manage") },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const { out } = z.object({ out: z.boolean() }).parse(req.body);
      if (await count("SELECT COUNT(*) c FROM accounts WHERE table_id=? AND status!='cerrada'", id))
        throw new HttpError(409, "mesa_ocupada", "La mesa tiene una cuenta abierta");
      const r = await db
        .prepare("UPDATE tables_ SET status=?, version=version+1 WHERE id=?")
        .run(out ? "fuera_de_servicio" : "disponible", id);
      if (r.changes === 0) throw new HttpError(404, "no_encontrado");
      await audit(
        db,
        req.user.sub,
        out ? "mesa_fuera_de_servicio" : "mesa_en_servicio",
        "table",
        id,
      );
      app.hub.emit({ type: "table.updated", tableId: id });
      return { ok: true };
    },
  );

  crud(app, {
    // Orden natural: T2 antes que T10
    path: "/api/tables",
    table: "tables_",
    entity: "table",
    write: "venue.manage",
    orderBy: "LENGTH(number), number",
    canDelete: async (tid) => {
      const n = await count("SELECT COUNT(*) c FROM accounts WHERE table_id=?", tid);
      return n
        ? "La mesa tiene historial de ventas: márcala como fuera de servicio en lugar de eliminarla"
        : null;
    },
    shape: {
      zone_id: z.string().nullable().optional(),
      number: z.string().min(1),
      capacity: z.number().int().min(1).default(4),
      vip: z.boolean().default(false),
      pos_x: z.number().default(0),
      pos_y: z.number().default(0),
    },
  });
}
