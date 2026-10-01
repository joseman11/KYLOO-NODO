import { networkInterfaces } from "node:os";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../db";
import { stripMarkup } from "../printing/markup";
import { DEFAULT_STYLE, SEPARATOR_CHARS, renderBill, renderComanda, type TicketStyle } from "../printing/render";

/** Ajustes del establecimiento. Lista cerrada de claves: jwt_secret nunca se expone. */
const KEYS = {
  establishment_name: z.string().min(1).max(80),
  discount_limit_pct: z.number().min(0).max(100),
  // Datos fiscales del emisor (facturación)
  fiscal_rfc: z.string().regex(/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i, "RFC no válido"),
  fiscal_name: z.string().min(1).max(200),
  fiscal_regimen: z.string().regex(/^\d{3}$/, "Régimen de 3 dígitos"),
  fiscal_cp: z.string().regex(/^\d{5}$/, "Código postal de 5 dígitos"),
  // Tickets: separadores y pie de página
  ticket_separator: z.enum(SEPARATOR_CHARS),
  ticket_group_categories: z.boolean(),
  ticket_footer: z.string().max(240),
  // Cargo por servicio (porcentaje; 0 = no se cobra) y desde cuántas personas aplica
  service_charge_pct: z.number().min(0).max(30),
  service_charge_min_guests: z.number().int().min(1).max(50),
  // Reparto de propinas
  tip_policy: z.enum(["individual", "pool"]),
  tip_roles: z.string().max(300).refine((v) => { try { const o = JSON.parse(v) as Record<string, unknown>; return Object.values(o).every((n) => typeof n === "number" && n >= 0 && n <= 100); } catch { return false; } }, "Reparto por rol no válido"),
  tip_support_pct: z.number().min(0).max(100),
} as const;

const DEFAULTS: Record<keyof typeof KEYS, string> = {
  establishment_name: "Restaurante", discount_limit_pct: "10", fiscal_rfc: "", fiscal_name: "", fiscal_regimen: "", fiscal_cp: "",
  ticket_separator: DEFAULT_STYLE.sep, ticket_group_categories: "0", ticket_footer: "",
  service_charge_pct: "0", service_charge_min_guests: "1", tip_policy: "individual", tip_roles: JSON.stringify({ mesero: 60, cocina: 25, bar: 15 }), tip_support_pct: "0",
};

const NUMBER_KEYS = new Set(["discount_limit_pct", "service_charge_pct", "service_charge_min_guests", "tip_support_pct"]);
const BOOLEAN_KEYS = new Set(["ticket_group_categories"]);

export async function settingsRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get("/api/settings", { preHandler: app.authorize() }, async () => {
    const out: Record<string, string | number | boolean> = {};
    for (const k of Object.keys(KEYS) as (keyof typeof KEYS)[]) {
      const row = await db.prepare("SELECT value FROM settings WHERE key=?").get(k) as { value: string } | undefined;
      const v = row?.value ?? DEFAULTS[k];
      out[k] = NUMBER_KEYS.has(k) ? Number(v) : BOOLEAN_KEYS.has(k) ? v === "1" : v;
    }
    return out;
  });

  // Direcciones del servidor en la red local (para armar los enlaces de los QR que abrirán tablets y teléfonos)
  app.get("/api/network", { preHandler: app.authorize() }, async (req) => ({
    port: req.socket.localPort,
    addresses: Object.values(networkInterfaces())
      .flat()
      .filter((i): i is NonNullable<typeof i> => !!i && i.family === "IPv4" && !i.internal)
      .map((i) => i.address),
  }));

  app.put("/api/settings", { preHandler: app.authorize("venue.manage") }, async (req) => {
    const b = z.object(KEYS).partial().strict().parse(req.body);
    for (const [k, v] of Object.entries(b)) {
      await db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, BOOLEAN_KEYS.has(k) ? (v ? "1" : "0") : String(v));
    }
    await audit(db, req.user.sub, "editar_ajustes", "sistema", undefined, b);
    return { ok: true };
  });

  // Vista previa de los tickets con el estilo indicado (aún sin guardar), usando el mismo renderizador que imprime
  app.post("/api/ticket-preview", { preHandler: app.authorize() }, async (req) => {
    const b = z
      .object({ sep: z.enum(SEPARATOR_CHARS).default("-"), groupCategories: z.boolean().default(false), footer: z.string().max(240).default(""), paper: z.union([z.literal(58), z.literal(80)]).default(80) })
      .parse(req.body ?? {});
    const style: TicketStyle = { sep: b.sep, groupCategories: b.groupCategories, footer: b.footer };
    const name = (await db.prepare("SELECT value FROM settings WHERE key='establishment_name'").get() as { value: string } | undefined)?.value ?? "Restaurante";
    const now = Date.now();
    const strip = (lines: string[]) => lines.map(stripMarkup);
    return {
      comanda: strip(
        renderComanda(
          {
            kind: "comanda", stationLabel: "Cocina / Calientes", tableNumber: "12", waiter: "Juan", folio: 48, createdAt: now,
            lines: [
              { quantity: 2, name: "Taco de calamar", modifiers: [], course: "Entradas" },
              { quantity: 1, name: "Tacos al pastor", modifiers: ["Sin cebolla"], course: "Entradas" },
              { quantity: 1, name: "Arrachera", modifiers: ["Término medio"], course: "Plato fuerte" },
            ],
          },
          b.paper, style,
        ),
      ),
      bill: strip(
        renderBill(
          {
            establishment: name, tableNumber: "12", waiter: "Juan", createdAt: now,
            lines: [
              { quantity: 2, name: "Taco de calamar", totalCents: 17000, category: "Tacos" },
              { quantity: 1, name: "Tacos al pastor", totalCents: 8500, category: "Tacos" },
              { quantity: 1, name: "Arrachera", totalCents: 24500, category: "Platos fuertes" },
              { quantity: 2, name: "Refresco", totalCents: 5000, category: "Bebidas" },
            ],
            totalCents: 55000,
          },
          b.paper, style,
        ),
      ),
    };
  });
}
