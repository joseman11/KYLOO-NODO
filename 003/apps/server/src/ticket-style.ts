import type { Db } from "./db";
import { DEFAULT_STYLE, SEPARATOR_CHARS, type TicketStyle } from "./printing/render";

const setting = (db: Db, key: string) => (db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined)?.value;

/** Estilo de tickets configurado por el establecimiento (separadores, agrupar por categoría, texto al pie). */
export function ticketStyle(db: Db): TicketStyle {
  const sep = setting(db, "ticket_separator");
  return {
    sep: sep && (SEPARATOR_CHARS as readonly string[]).includes(sep) ? sep : DEFAULT_STYLE.sep,
    groupCategories: setting(db, "ticket_group_categories") === "1",
    footer: setting(db, "ticket_footer") ?? "",
  };
}
