import { existsSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyJwt from "@fastify/jwt";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { can, type Permission, type Role } from "@003/shared";
import { jwtSecret, type Db } from "./db";
import { HttpError } from "./domain";
import { Hub } from "./hub";
import { tcpTransport, type PrinterTransport } from "./printing/transport";
import { authRoutes } from "./routes/auth";
import { venueRoutes } from "./routes/venue";
import { catalogRoutes } from "./routes/catalog";
import { operationsRoutes } from "./routes/operations";
import { cashRoutes } from "./routes/cash";
import { printingRoutes } from "./routes/printing";
import { reportRoutes } from "./routes/reports";
import { inventoryRoutes } from "./routes/inventory";
import { shoppingRoutes } from "./routes/shopping";
import { recipeBookRoutes } from "./routes/recipebook";
import { promotionRoutes } from "./routes/promotions";
import { customerRoutes } from "./routes/customers";
import { deliveryRoutes } from "./routes/delivery";
import { publicRoutes } from "./routes/public";
import { settingsRoutes } from "./routes/settings";
import { serviceRoutes } from "./routes/service";
import { photoRoutes } from "./routes/photos";
import { staffRoutes } from "./routes/staff";
import { giftCardRoutes } from "./routes/giftcards";
import { analyticsRoutes } from "./routes/analytics";
import { integrationRoutes } from "./routes/integrations";
import { syncRoutes } from "./routes/sync";
import { invoiceRoutes, sandboxProvider, type InvoiceProvider } from "./routes/invoices";
import { cloudRoutes, type HttpLike } from "./routes/cloud";
import { hqRoutes, type HqOptions } from "./routes/hq";
import { connectWebhooks } from "./webhooks";
import { FEATURE_ROUTES, getLicense, usage } from "./license";

export interface AuthUser {
  sub: string;
  role: Role;
  permissions: Permission[];
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    hub: Hub;
    /** preHandler: exige sesión válida y el permiso indicado (RN-015). Sin permiso, solo sesión. */
    authorize(permission?: Permission): (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface AppOptions {
  hub?: Hub;
  transport?: PrinterTransport;
  backupDir?: string;
  /** Carpeta con la PWA compilada (apps/web/dist). */
  webDir?: string;
  /** Proveedor de timbrado (PAC). Por defecto, el proveedor de prueba sin validez fiscal. */
  invoiceProvider?: InvoiceProvider;
  /** Cliente HTTP hacia la nube (HQ). Inyectable para pruebas. */
  http?: HttpLike;
  /** Activa las rutas de la nube (organizaciones, sucursales, licencias). Solo en el servidor HQ. */
  hq?: HqOptions | false;
  /** Carpeta donde se guardan las fotos de los platillos. */
  photosDir?: string;
}

export function buildApp(db: Db, options: AppOptions = {}): FastifyInstance {
  // Las fotos viajan en base64 (ya reducidas por el cliente): margen para ~800 KB de imagen
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  // Un cuerpo JSON vacío (p. ej. DELETE desde un cliente que declara JSON) se acepta como «sin cuerpo»; el JSON mal formado sigue siendo 400
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = String(body).trim();
    if (!text) return done(null, undefined);
    try { done(null, JSON.parse(text)); } catch { const e = new Error("JSON inválido") as Error & { statusCode: number }; e.statusCode = 400; done(e, undefined); }
  });
  const hub = options.hub ?? new Hub();
  const transport = options.transport ?? tcpTransport;

  app.decorate("db", db);
  app.decorate("hub", hub);
  app.register(fastifyJwt, { secret: jwtSecret(db), sign: { expiresIn: "12h" } });
  app.register(fastifyWebsocket);

  app.decorate("authorize", (permission?: Permission) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "no_autenticado" });
    }
    if (permission && !can(req.user.permissions, permission)) {
      return reply.code(403).send({ error: "sin_permiso", permission });
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "validacion", issues: err.issues });
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    if (/UNIQUE|FOREIGN KEY|CHECK|NOT NULL/.test(err.message)) {
      // Mensajes comprensibles para los casos más comunes; el detalle técnico se conserva en `detail`
      const friendly = /UNIQUE constraint failed: tables_\.number/.test(err.message) ? "Ya existe una mesa con ese número"
        : /UNIQUE constraint failed: zones/.test(err.message) ? "Ya existe un área con ese nombre"
        : /UNIQUE constraint failed: products\.sku/.test(err.message) ? "Ya existe un producto con ese SKU"
        : /UNIQUE/.test(err.message) ? "Ya existe un registro con ese valor"
        : /FOREIGN KEY/.test(err.message) ? "No se puede completar: está relacionado con otros datos"
        : err.message;
      return reply.code(409).send({ error: "conflicto", message: friendly, detail: err.message });
    }
    return reply.code(err.statusCode ?? 500).send({ error: err.message });
  });

  // Dispositivos conectados por WebSocket (tablets, KDS, caja)
  let devices = 0;
  app.get("/api/health", async () => ({ ok: true, devices }));

  // Tiempo real: cada dispositivo abre /ws?token=JWT y recibe los eventos del hub
  app.register(async (scope) => {
    scope.get("/ws", { websocket: true }, (socket, req) => {
      try {
        app.jwt.verify((req.query as { token?: string }).token ?? "");
      } catch {
        socket.close(4401, "no_autenticado");
        return;
      }
      const stop = hub.subscribe((e) => socket.send(JSON.stringify(e)));
      devices++;
      let closed = false;
      const unsubscribe = () => {
        if (closed) return;
        closed = true;
        devices--;
        stop();
      };
      socket.on("close", unsubscribe);
      socket.on("error", unsubscribe);
    });
  });

  app.register(authRoutes);
  app.register(venueRoutes);
  app.register(catalogRoutes);
  app.register(operationsRoutes, { hub });
  app.register(cashRoutes, { hub });
  app.register(printingRoutes, { hub, transport });
  app.register(reportRoutes, { backupDir: options.backupDir ?? "data/backups" });
  app.register(inventoryRoutes);
  app.register(shoppingRoutes);
  app.register(recipeBookRoutes);
  app.register(promotionRoutes);
  app.register(customerRoutes);
  app.register(deliveryRoutes);
  app.register(publicRoutes);
  app.register(settingsRoutes);
  app.register(serviceRoutes);
  app.register(photoRoutes, { dir: options.photosDir ?? "data/photos" });
  app.register(staffRoutes);
  app.register(giftCardRoutes);
  app.register(analyticsRoutes);
  app.register(integrationRoutes);
  app.register(syncRoutes);
  app.register(invoiceRoutes, { provider: options.invoiceProvider ?? sandboxProvider });
  app.register(cloudRoutes, { http: options.http ?? ((url, init) => fetch(url, init)) });
  if (options.hq) app.register(hqRoutes, options.hq);

  // Webhooks salientes: cada evento en tiempo real también se encola para los endpoints suscritos
  connectWebhooks(db, hub);

  // Plan SaaS: con licencia instalada se aplican funciones y límites; sin licencia (instalación propia) no hay límites
  app.addHook("onRequest", async (req, reply) => {
    const lic = await getLicense(db);
    if (!lic) return;
    const path = req.url.split("?")[0]!;
    for (const [re, feature] of FEATURE_ROUTES) {
      if (re.test(path) && !lic.features.includes(feature)) {
        return reply.code(402).send({ error: "plan_no_incluye", feature, plan: lic.plan, message: `Tu plan ${lic.plan} no incluye ${feature}` });
      }
    }
    if (req.method === "POST") {
      const u = await usage(db);
      const hit = path === "/api/users" ? (lic.limits.users !== null && u.users >= lic.limits.users ? "usuarios" : null)
        : path === "/api/printers" ? (lic.limits.printers !== null && u.printers >= lic.limits.printers ? "impresoras" : null)
        : null;
      if (hit) return reply.code(402).send({ error: "limite_plan", message: `Tu plan ${lic.plan} llegó al límite de ${hit}` });
    }
  });

  if (options.webDir && existsSync(options.webDir)) {
    app.register(fastifyStatic, { root: options.webDir });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api") ? reply.code(404).send({ error: "no_encontrado" }) : reply.sendFile("index.html"),
    );
  }

  return app;
}
