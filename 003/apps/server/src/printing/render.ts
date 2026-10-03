import { BIG, BOLD, HUGE } from "./markup";

/** Render de tickets a líneas de texto (el ancho depende del papel: 58mm ≈ 32 cols, 80mm ≈ 42 cols). */

export const widthFor = (paper: number) => (paper === 58 ? 32 : 42);

/** Estilo configurable de los tickets: carácter de los separadores, agrupar por categoría y texto al pie. */
export interface TicketStyle {
  /** Un solo carácter con el que se dibujan las líneas separadoras. */
  sep: string;
  groupCategories: boolean;
  footer: string;
}

export const DEFAULT_STYLE: TicketStyle = { sep: "-", groupCategories: false, footer: "" };
export const SEPARATOR_CHARS = ["-", "=", "*", ".", "_", "~"] as const;

const rule = (w: number, ch = "-") => ch.repeat(w);
const two = (l: string, r: string, w: number) => {
  const gap = w - l.length - r.length;
  return gap >= 1 ? l + " ".repeat(gap) + r : `${l}\n${r.padStart(w)}`;
};

/** Separador con título centrado: `---- PLATO FUERTE ----`. */
export function titled(label: string, w: number, ch = "-"): string {
  const text = ` ${label.toUpperCase()} `;
  if (text.length >= w) return text.trim();
  const left = Math.floor((w - text.length) / 2);
  return ch.repeat(left) + text + ch.repeat(w - text.length - left);
}

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleString("es-MX", { hour12: false, dateStyle: "short", timeStyle: "short" });
export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export interface TicketLineData {
  quantity: number;
  name: string;
  modifiers: string[];
  note?: string | null;
  /** Tiempo o separador de la comanda (Entradas, Plato fuerte, Postre…). */
  course?: string | null;
  /** Asiento de la mesa. */
  seat?: number | null;
}

export interface ComandaData {
  /** "tiempo": se manda a producir un tiempo que estaba retenido (hold & fire). */
  kind: "comanda" | "adicion" | "tiempo";
  /** Título grande opcional (p. ej. el nombre del tiempo que sale). */
  headline?: string;
  stationLabel: string;
  tableNumber: string;
  waiter: string;
  folio: number;
  createdAt: number;
  lines: TicketLineData[];
}

export function renderComanda(
  d: ComandaData,
  paper = 80,
  style: TicketStyle = DEFAULT_STYLE,
): string[] {
  const w = widthFor(paper);
  const out = [
    `${BIG}${d.headline ?? (d.kind === "adicion" ? "ADICION" : "COMANDA")}`,
    `${BOLD}${d.stationLabel}`,
    // El número de mesa va enorme y centrado: la cocina lo lee desde lejos
    `${BOLD}MESA`,
    `${HUGE}${d.tableNumber}`,
    two(`Mesero: ${d.waiter}`, `#${d.folio}`, w),
    fmtTime(d.createdAt),
    rule(w, style.sep),
  ];
  let course: string | null | undefined;
  for (const l of d.lines) {
    // Al cambiar de tiempo se imprime un separador con su nombre, para que la cocina sepa cuándo sacar cada parte
    if ((l.course ?? null) !== (course ?? null) && l.course)
      out.push(`${BOLD}${titled(l.course, w, style.sep)}`);
    course = l.course;
    out.push(
      `${BOLD}${d.kind === "adicion" ? "+ " : ""}${l.quantity} x ${l.name}${l.seat ? ` (A${l.seat})` : ""}`,
    );
    for (const m of l.modifiers) out.push(`   - ${m}`);
    if (l.note) out.push(`   >> ${l.note}`);
  }
  out.push(rule(w, style.sep));
  return out.flatMap((s) => s.split("\n"));
}

export interface BillData {
  establishment: string;
  tableNumber: string;
  waiter: string;
  createdAt: number;
  lines: { quantity: number; name: string; totalCents: number; category?: string | null }[];
  totalCents: number;
  discountCents?: number;
  serviceChargeCents?: number;
  serviceChargeLabel?: string;
  deliveryFeeCents?: number;
  /** Cobro parcial (partes iguales o por asiento): se imprime lo cubierto y lo pendiente. */
  partial?: { coveredCents: number; balanceCents: number };
  tipCents?: number;
  payments?: { method: string; amountCents: number }[];
  changeCents?: number;
}

export function renderBill(d: BillData, paper = 80, style: TicketStyle = DEFAULT_STYLE): string[] {
  const w = widthFor(paper);
  const out = [
    `${BIG}${d.establishment}`,
    `Mesa ${d.tableNumber} - ${d.waiter}`,
    fmtTime(d.createdAt),
    rule(w, style.sep),
  ];

  if (style.groupCategories) {
    // Un encabezado por categoría, en el orden en que se pidió
    const groups = new Map<string, BillData["lines"]>();
    for (const l of d.lines)
      groups.set(l.category ?? "Otros", [...(groups.get(l.category ?? "Otros") ?? []), l]);
    for (const [cat, lines] of groups) {
      out.push(`${BOLD}${titled(cat, w, style.sep)}`);
      for (const l of lines) out.push(two(`${l.quantity} ${l.name}`, money(l.totalCents), w));
    }
  } else {
    for (const l of d.lines) out.push(two(`${l.quantity} ${l.name}`, money(l.totalCents), w));
  }

  out.push(rule(w, style.sep));
  if (d.discountCents) out.push(two("Descuento", `-${money(d.discountCents)}`, w));
  if (d.serviceChargeCents)
    out.push(two(d.serviceChargeLabel ?? "Servicio", money(d.serviceChargeCents), w));
  if (d.deliveryFeeCents) out.push(two("Envio", money(d.deliveryFeeCents), w));
  out.push(`${BOLD}${two("TOTAL", money(d.totalCents), w)}`);
  if (d.tipCents) out.push(two("Propina", money(d.tipCents), w));
  for (const p of d.payments ?? []) out.push(two(p.method, money(p.amountCents), w));
  if (d.changeCents) out.push(two("Cambio", money(d.changeCents), w));
  if (d.partial)
    out.push(
      rule(w, style.sep),
      two("Pago parcial", money(d.partial.coveredCents), w),
      two("Saldo pendiente", money(d.partial.balanceCents), w),
    );
  out.push("", "Gracias por su visita");
  if (style.footer.trim())
    out.push(rule(w, style.sep), ...style.footer.split("\n").map((s) => s.trimEnd()));
  return out.flatMap((s) => s.split("\n"));
}

export function renderTest(
  printerName: string,
  paper = 80,
  style: TicketStyle = DEFAULT_STYLE,
): string[] {
  const w = widthFor(paper);
  return [
    `${BIG}PRUEBA`,
    printerName,
    fmtTime(Date.now()),
    rule(w, style.sep),
    "Impresion correcta: áéíóúñ ¿¡",
    rule(w, style.sep),
  ];
}
