import type { FastifyInstance } from "fastify";
import { z } from "zod";

const itemSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().min(1).max(99).default(1),
  modifierIds: z.array(z.string()).default([]),
  note: z.string().max(200).optional(),
  course: z.string().trim().min(1).max(40).optional(),
});

const opSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(8),
    type: z.literal("open_table"),
    tableId: z.string(),
    guests: z.number().int().min(1).default(1),
  }),
  // La cuenta se indica por id (si ya existía) o por referencia a la operación open_table que la creó sin conexión
  z.object({
    id: z.string().min(8),
    type: z.literal("order"),
    accountId: z.string().optional(),
    accountRef: z.string().optional(),
    items: z.array(itemSchema).min(1),
  }),
  z.object({
    id: z.string().min(8),
    type: z.literal("request_bill"),
    accountId: z.string().optional(),
    accountRef: z.string().optional(),
  }),
]);

/** Códigos que significan "el estado cambió mientras estabas sin red": se reportan como conflicto, no como error. */
const CONFLICTS = new Set([
  "mesa_ocupada",
  "cuenta_cerrada",
  "producto_agotado",
  "sin_cuenta_abierta",
]);

/**
 * Sincronización por lotes (Fase 3, offline avanzado): el dispositivo envía lo que hizo sin conexión.
 * Cada operación lleva un id: reenviar el lote nunca duplica comandas ni mesas abiertas.
 */
export async function syncRoutes(app: FastifyInstance) {
  const { db } = app;

  app.post("/api/sync", { preHandler: app.authorize("order.create") }, async (req) => {
    const { ops } = z.object({ ops: z.array(z.unknown()).min(1).max(100) }).parse(req.body);
    const headers = { Authorization: req.headers.authorization ?? "" };
    const results: {
      id: string;
      status: "ok" | "duplicate" | "conflict" | "error";
      code?: string;
      message?: string;
      data?: unknown;
    }[] = [];
    // Si una mesa no se pudo abrir, lo que dependía de ella (comandas) se reporta como conflicto en cadena
    const failedAccounts = new Set<string>();

    for (const raw of ops) {
      const parsed = opSchema.safeParse(raw);
      const id = (raw as { id?: string })?.id ?? "?";
      if (!parsed.success) {
        results.push({
          id,
          status: "error",
          code: "validacion",
          message: parsed.error.issues[0]?.message,
        });
        continue;
      }
      const op = parsed.data;

      const seen = (await db
        .prepare("SELECT status, result FROM sync_ops WHERE id=?")
        .get(op.id)) as { status: string; result: string | null } | undefined;
      if (seen) {
        const stored = seen.result ? (JSON.parse(seen.result) as { code?: string }) : undefined;
        // Un reenvío devuelve el resultado original: lo que fue conflicto o error sigue siéndolo
        results.push(
          seen.status === "ok"
            ? { id: op.id, status: "duplicate", data: stored }
            : { id: op.id, status: seen.status as "conflict" | "error", code: stored?.code },
        );
        if (seen.status !== "ok" && op.type === "open_table") failedAccounts.add(op.id);
        continue;
      }
      let accountId = "";
      if (op.type !== "open_table") {
        const ref = op.accountRef;
        if (ref && failedAccounts.has(ref)) {
          results.push({
            id: op.id,
            status: "conflict",
            code: "cuenta_no_abierta",
            message: "La mesa no pudo abrirse",
          });
          continue;
        }
        accountId =
          op.accountId ??
          (ref
            ? ((
                (await db.prepare("SELECT id FROM accounts WHERE client_id=?").get(ref)) as
                  | { id: string }
                  | undefined
              )?.id ?? "")
            : "");
        if (!accountId) {
          results.push({
            id: op.id,
            status: "error",
            code: "cuenta_desconocida",
            message: "Indica accountId o accountRef",
          });
          continue;
        }
      }

      const res =
        op.type === "open_table"
          ? await app.inject({
              method: "POST",
              url: `/api/tables/${op.tableId}/open`,
              headers,
              payload: { guests: op.guests, clientId: op.id },
            })
          : op.type === "order"
            ? await app.inject({
                method: "POST",
                url: `/api/accounts/${accountId}/orders`,
                headers,
                payload: { items: op.items, clientId: op.id },
              })
            : await app.inject({
                method: "POST",
                url: `/api/accounts/${accountId}/request-bill`,
                headers,
                payload: {},
              });

      const body = (res.body ? res.json() : {}) as {
        error?: string;
        message?: string;
        id?: string;
      };
      const status =
        res.statusCode < 400 ? "ok" : CONFLICTS.has(body.error ?? "") ? "conflict" : "error";
      const result = {
        id: op.id,
        status,
        ...(status !== "ok" ? { code: body.error, message: body.message } : { data: body }),
      } as (typeof results)[number];
      if (status !== "ok" && op.type === "open_table") failedAccounts.add(op.id);
      await db
        .prepare(
          "INSERT INTO sync_ops (id,user_id,type,status,result,created_at) VALUES (?,?,?,?,?,?)",
        )
        .run(
          op.id,
          req.user.sub,
          op.type,
          status,
          JSON.stringify(result.data ?? { code: result.code }),
          Date.now(),
        );
      results.push(result);
    }
    return { results };
  });
}
