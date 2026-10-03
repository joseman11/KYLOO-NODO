import type { Db } from "./db";
import { DEFAULT_STYLE, SEPARATOR_CHARS, type TicketStyle } from "./printing/render";

const setting = async (db: Db, key: string) => (await db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined)?.value;

/** Estilo de tickets configurado por el establecimiento (separadores, agrupar por categoría, texto al pie). */
export async function ticketStyle(db: Db): Promise<TicketStyle> {
  const sep = await setting(db, "ticket_separator");
  return {
    sep: sep && (SEPARATOR_CHARS as readonly string[]).includes(sep) ? sep : DEFAULT_STYLE.sep,
    groupCategories: await setting(db, "ticket_group_categories") === "1",
    footer: await setting(db, "ticket_footer") ?? "",
  };
}
