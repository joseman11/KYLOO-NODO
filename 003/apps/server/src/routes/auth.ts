import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ROLES, type Role } from "@003/shared";
import { audit, newId } from "../db";
import { hashSecret, verifySecret } from "../crypto";
import { permissionsFor } from "../perms";

const MAX_ATTEMPTS = 5;
const LOCK_MS = 60_000;

interface UserRow {
  id: string;
  name: string;
  role: Role;
  pin_hash: string | null;
  password_hash: string | null;
  failed_attempts: number;
  locked_until: number;
  active: number;
}

export async function authRoutes(app: FastifyInstance) {
  const { db } = app;

  function issue(user: UserRow) {
    const token = app.jwt.sign({ sub: user.id, role: user.role, permissions: permissionsFor(user.role) });
    return { token, user: { id: user.id, name: user.name, role: user.role, photo: (user as { photo?: string | null }).photo ?? null, permissions: permissionsFor(user.role) } };
  }

  /** Cuenta intentos fallidos y bloquea temporalmente (protección contra fuerza bruta de PIN). */
  function attempt(user: UserRow | undefined, ok: (u: UserRow) => boolean) {
    if (!user || !user.active) return { status: 401 as const };
    if (user.locked_until > Date.now()) return { status: 429 as const };
    if (ok(user)) {
      db.prepare("UPDATE users SET failed_attempts=0, locked_until=0 WHERE id=?").run(user.id);
      return { status: 200 as const, user };
    }
    const failed = user.failed_attempts + 1;
    const lockedUntil = failed >= MAX_ATTEMPTS ? Date.now() + LOCK_MS : 0;
    db.prepare("UPDATE users SET failed_attempts=?, locked_until=? WHERE id=?").run(
      lockedUntil ? 0 : failed,
      lockedUntil,
      user.id,
    );
    return { status: 401 as const };
  }

  // Selector de usuario para el login por PIN (solo nombre y rol)
  app.get("/api/auth/users", async () =>
    db.prepare("SELECT id, name, role, photo FROM users WHERE active=1 ORDER BY name").all(),
  );

  // Datos públicos para la pantalla de acceso
  app.get("/api/auth/info", async () => {
    const r = db.prepare("SELECT value FROM settings WHERE key='establishment_name'").get() as { value: string } | undefined;
    return { name: r?.value ?? null };
  });

  app.post("/api/auth/pin", async (req, reply) => {
    const body = z.object({ userId: z.string(), pin: z.string().regex(/^\d{4,8}$/) }).parse(req.body);
    const user = db.prepare("SELECT * FROM users WHERE id=?").get(body.userId) as UserRow | undefined;
    const r = attempt(user, (u) => verifySecret(body.pin, u.pin_hash));
    if (r.status !== 200) {
      audit(db, user?.id ?? null, "login.fallido", "user", body.userId);
      return reply.code(r.status).send({ error: r.status === 429 ? "bloqueado_temporalmente" : "credenciales_invalidas" });
    }
    audit(db, r.user.id, "login", "user", r.user.id, { metodo: "pin" });
    return issue(r.user);
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = z.object({ username: z.string(), password: z.string() }).parse(req.body);
    const user = db.prepare("SELECT * FROM users WHERE username=?").get(body.username) as UserRow | undefined;
    const r = attempt(user, (u) => verifySecret(body.password, u.password_hash));
    if (r.status !== 200) {
      audit(db, user?.id ?? null, "login.fallido", "user", user?.id);
      return reply.code(r.status).send({ error: r.status === 429 ? "bloqueado_temporalmente" : "credenciales_invalidas" });
    }
    audit(db, r.user.id, "login", "user", r.user.id, { metodo: "password" });
    return issue(r.user);
  });

  app.get("/api/me", { preHandler: app.authorize() }, async (req) => req.user);

  app.post("/api/auth/logout", { preHandler: app.authorize() }, async (req) => {
    audit(db, req.user.sub, "logout", "user", req.user.sub);
    return { ok: true };
  });

  // --- Gestión de usuarios (user.manage) ---
  const userBody = z.object({
    name: z.string().min(1),
    role: z.enum(ROLES),
    username: z.string().min(3).optional(),
    password: z.string().min(8).optional(),
    pin: z.string().regex(/^\d{4,8}$/).optional(),
  });

  app.get("/api/users", { preHandler: app.authorize("user.manage") }, async () =>
    db.prepare("SELECT id, name, username, role, active, photo, (pin_hash IS NOT NULL) AS has_pin FROM users ORDER BY name").all(),
  );

  app.post("/api/users", { preHandler: app.authorize("user.manage") }, async (req, reply) => {
    const b = userBody.parse(req.body);
    if (!b.pin && !(b.username && b.password)) {
      return reply.code(400).send({ error: "validacion", message: "Requiere PIN o usuario+contraseña" });
    }
    const id = newId();
    db.prepare(
      "INSERT INTO users (id,name,username,role,pin_hash,password_hash,created_at) VALUES (?,?,?,?,?,?,?)",
    ).run(id, b.name, b.username ?? null, b.role, b.pin ? hashSecret(b.pin) : null, b.password ? hashSecret(b.password) : null, Date.now());
    audit(db, req.user.sub, "crear", "user", id, { name: b.name, role: b.role });
    return reply.code(201).send({ id });
  });

  app.patch("/api/users/:id", { preHandler: app.authorize("user.manage") }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = userBody.partial().extend({ active: z.boolean().optional() }).parse(req.body);
    if (b.name !== undefined) db.prepare("UPDATE users SET name=? WHERE id=?").run(b.name, id);
    if (b.role !== undefined) db.prepare("UPDATE users SET role=? WHERE id=?").run(b.role, id);
    if (b.pin) db.prepare("UPDATE users SET pin_hash=? WHERE id=?").run(hashSecret(b.pin), id);
    if (b.password) db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hashSecret(b.password), id);
    if (b.active !== undefined) db.prepare("UPDATE users SET active=? WHERE id=?").run(b.active ? 1 : 0, id);
    audit(db, req.user.sub, "editar", "user", id, { campos: Object.keys(b).filter((k) => k !== "pin" && k !== "password") });
    return { ok: true };
  });
}
