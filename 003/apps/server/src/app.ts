import { join } from "node:path";
import { existsSync } from "node:fs";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
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
import { setupRoutes } from "./routes/setup";
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
import { type Uploader, streamUpload } from "./cloud-backup";
import { cloudRoutes, type HttpLike } from "./routes/cloud";
import { cloudBackupRoutes } from "./routes/cloud-backup";
import { hqRoutes, type HqOptions } from "./routes/hq";
import { connectWebhooks } from "./webhooks";
import {
  FEATURE_ROUTES,
  type LicensingContext,
  OPEN_LICENSING,
  getLicense,
  usage,
} from "./license";
import { appVersion } from "./config";
import { type LogLevel, fastifyLoggerOptions } from "./logging";

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
    /** Cómo se aplica la licencia en este arranque. */
    licensing: LicensingContext;
    /** Dirección del HQ de Nodo (para activar con un código), si se conoce. */
    hqUrl: string | null;
    /** Nombre `.local` que anuncia el servidor por mDNS (`null` si no se anuncia). */
    mdnsHost: string | null;
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
  /** Subida de respaldos al HQ (inyectable en pruebas). */
  uploader?: Uploader;
  /** Registro de la aplicación (archivo con rotación). Sin él no se registra nada, como en las pruebas. */
  logger?: { stream: { write(s: string): void }; level: LogLevel };
  /** Cómo se aplica la licencia (por defecto `open`: sin licencia no hay límites; solo el paquete de producción usa `enforced`). */
  licensing?: LicensingContext;
  /** Dirección del HQ de Nodo para activar la licencia con un código. */
  hqUrl?: string | null;
  /** Nombre `.local` anunciado por mDNS (para mostrar cómo conectar una tablet). */
  mdnsHost?: string | null;
  /** Versión que publica `/api/health` (por defecto, la del paquete). */
  version?: string;
}

export function buildApp(db: Db, options: AppOptions = {}): FastifyInstance {
  // Las fotos viajan en base64 (ya reducidas por el cliente): margen para ~800 KB de imagen
  const app = Fastify({
    logger: options.logger
      ? fastifyLoggerOptions(options.logger.stream, options.logger.level)
      : false,
    // Una línea por petición llenaría el disco de un local; solo se registran los errores
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 2 * 1024 * 1024,
  });
  // Un cuerpo JSON vacío (p. ej. DELETE desde un cliente que declara JSON) se acepta como «sin cuerpo»; el JSON mal formado sigue siendo 400
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = String(body).trim();
    if (!text) return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      const e = new Error("JSON inválido") as Error & { statusCode: number };
      e.statusCode = 400;
      done(e, undefined);
    }
  });
  const hub = options.hub ?? new Hub();
  const transport = options.transport ?? tcpTransport;

  app.decorate("db", db);
  app.decorate("hub", hub);
  const licensing = options.licensing ?? OPEN_LICENSING;
  app.decorate("licensing", licensing);
  app.decorate("hqUrl", options.hqUrl ?? null);
  app.decorate("mdnsHost", options.mdnsHost ?? null);
  app.register(fastifyJwt, { secret: jwtSecret(db), sign: { expiresIn: "12h" } });
  app.register(fastifyWebsocket);

  app.decorate(
    "authorize",
    (permission?: Permission) => async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        await req.jwtVerify();
      } catch {
        return reply.code(401).send({ error: "no_autenticado" });
      }
      if (permission && !can(req.user.permissions, permission)) {
        return reply.code(403).send({ error: "sin_permiso", permission });
      }
    },
  );

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof ZodError)
      return reply.code(400).send({ error: "validacion", issues: err.issues });
    if (err instanceof HttpError)
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    const pgCode = (err as { code?: string }).code;
    const constraint = (err as { constraint?: string }).constraint ?? "";
    // Texto que PostgreSQL no admite (p. ej. el byte NUL): es una entrada inválida, no un fallo del servidor
    if (pgCode === "22021" || pgCode === "22P05")
      return reply
        .code(400)
        .send({ error: "validacion", message: "Texto con caracteres no válidos" });
    if (
      /UNIQUE|FOREIGN KEY|CHECK|NOT NULL/.test(err.message) ||
      (pgCode && pgCode.startsWith("23"))
    ) {
      // Mensajes comprensibles para los casos más comunes; el detalle técnico se conserva en `detail`
      const unique = /UNIQUE/.test(err.message) || pgCode === "23505";
      const friendly =
        unique &&
        (/UNIQUE constraint failed: tables_\.number/.test(err.message) ||
          constraint.startsWith("tables__number"))
          ? "Ya existe una mesa con ese número"
          : unique &&
              (/UNIQUE constraint failed: zones/.test(err.message) ||
                constraint.startsWith("zones_"))
            ? "Ya existe un área con ese nombre"
            : unique &&
                (/UNIQUE constraint failed: products\.sku/.test(err.message) ||
                  constraint.startsWith("products_sku"))
              ? "Ya existe un producto con ese SKU"
              : unique
                ? "Ya existe un registro con ese valor"
                : /FOREIGN KEY/.test(err.message) || pgCode === "23503"
                  ? "No se puede completar: está relacionado con otros datos"
                  : err.message;
      if (process.env.NODO_DEBUG) console.error("[409]", err.message);
      return reply.code(409).send({ error: "conflicto", message: friendly, detail: err.message });
    }
    // Los 5xx son lo único que se registra de una petición (Fastify, con disableRequestLogging, no lo hace solo)
    if ((err.statusCode ?? 500) >= 500) req.log.error({ req, err }, err.message);
    return reply.code(err.statusCode ?? 500).send({ error: err.message });
  });

  // Dispositivos conectados por WebSocket (tablets, KDS, caja)
  let devices = 0;
  const version = options.version ?? appVersion();
  const startedAt = Date.now();
  app.get("/api/health", async () => ({
    ok: true,
    devices,
    version,
    engine: db.dialect,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
  }));

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

  app.register(setupRoutes);
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
  app.register(cloudBackupRoutes, {
    upload: options.uploader ?? streamUpload,
    photosDir: options.photosDir,
    workDir: join(options.backupDir ?? "data/backups", ".trabajo"),
  });
  if (options.hq) app.register(hqRoutes, options.hq);

  // Webhooks salientes: cada evento en tiempo real también se encola para los endpoints suscritos
  connectWebhooks(db, hub);

  // Plan SaaS: con licencia instalada se aplican funciones y límites. Sin licencia: en modo `open` (desarrollo) no hay
  // límites; en modo `enforced` (paquete de producción) rige el plan gratis, sin detener nunca la venta
  app.addHook("onRequest", async (req, reply) => {
    const lic = await getLicense(db, Date.now(), licensing);
    if (!lic) return;
    const path = req.url.split("?")[0]!;
    for (const [re, feature] of FEATURE_ROUTES) {
      if (re.test(path) && !lic.features.includes(feature)) {
        return reply.code(402).send({
          error: "plan_no_incluye",
          feature,
          plan: lic.plan,
          message: `Tu plan ${lic.plan} no incluye ${feature}`,
        });
      }
    }
    if (req.method === "POST") {
      const u = await usage(db);
      const hit =
        path === "/api/users"
          ? lic.limits.users !== null && u.users >= lic.limits.users
            ? "usuarios"
            : null
          : path === "/api/printers"
            ? lic.limits.printers !== null && u.printers >= lic.limits.printers
              ? "impresoras"
              : null
            : null;
      if (hit)
        return reply
          .code(402)
          .send({ error: "limite_plan", message: `Tu plan ${lic.plan} llegó al límite de ${hit}` });
    }
  });

  if (options.webDir && existsSync(options.webDir)) {
    app.register(fastifyStatic, { root: options.webDir });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api")
        ? reply.code(404).send({ error: "no_encontrado" })
        : reply.sendFile("index.html"),
    );
  }

  return app;
}
