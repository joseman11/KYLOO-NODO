/**
 * Construcción de CFDI 4.0 (sin timbre). Función pura: recibe la cuenta ya cobrada y devuelve XML y totales.
 * Los precios del menú incluyen IVA (16 %); aquí se separa la base y el impuesto de forma que
 * SubTotal − Descuento + IVA = Total cobrado, al centavo.
 */

export const IVA_RATE = 0.16;

export interface CfdiEmisor { rfc: string; nombre: string; regimen: string; cp: string; }
export interface CfdiReceptor { rfc: string; nombre: string; cp: string; regimen: string; usoCfdi: string; }
export interface CfdiLine { description: string; quantity: number; unitGrossCents: number; }

export interface CfdiInput {
  emisor: CfdiEmisor;
  receptor: CfdiReceptor;
  serie: string;
  folio: number;
  fecha: Date;
  formaPago: string;
  metodoPago: string;
  lines: CfdiLine[];
  /** Total cobrado con IVA, después de descuentos. */
  totalCents: number;
}

export interface CfdiTotals { subtotalCents: number; discountCents: number; baseCents: number; ivaCents: number; totalCents: number; }

const money = (c: number) => (c / 100).toFixed(2);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

export function computeTotals(lines: CfdiLine[], totalCents: number): { totals: CfdiTotals; netByLine: number[] } {
  const grossItems = lines.reduce((s, l) => s + l.quantity * l.unitGrossCents, 0);
  const subtotal = Math.round(grossItems / (1 + IVA_RATE));
  const base = Math.round(totalCents / (1 + IVA_RATE));
  const discount = Math.max(0, subtotal - base);

  // Reparto proporcional del subtotal entre conceptos; el último absorbe el redondeo
  const netByLine: number[] = [];
  let acc = 0;
  lines.forEach((l, i) => {
    const net = i === lines.length - 1 ? subtotal - acc : Math.round(((l.quantity * l.unitGrossCents) / (grossItems || 1)) * subtotal);
    netByLine.push(net);
    acc += net;
  });
  return { totals: { subtotalCents: subtotal, discountCents: discount, baseCents: base, ivaCents: totalCents - base, totalCents }, netByLine };
}

export function buildCfdiXml(input: CfdiInput, opts: { sandbox: boolean }): { xml: string; totals: CfdiTotals } {
  const { totals, netByLine } = computeTotals(input.lines, input.totalCents);
  const e = input.emisor;
  const r = input.receptor;

  // IVA por concepto proporcional a la base neta (después de descuento); el último absorbe el redondeo
  let ivaAcc = 0;
  const concepts = input.lines.map((l, i) => {
    const importe = netByLine[i]!;
    const discount = totals.subtotalCents ? Math.round((importe / totals.subtotalCents) * totals.discountCents) : 0;
    const base = importe - discount;
    const iva = i === input.lines.length - 1 ? totals.ivaCents - ivaAcc : Math.round(base * IVA_RATE);
    ivaAcc += iva;
    return { l, importe, discount, base, iva, valorUnitario: l.quantity ? importe / l.quantity : 0 };
  });

  const conceptXml = concepts
    .map(
      (c) => `    <cfdi:Concepto ClaveProdServ="90101501" Cantidad="${c.l.quantity}" ClaveUnidad="H87" Unidad="Pieza" Descripcion="${esc(c.l.description)}" ValorUnitario="${(c.valorUnitario / 100).toFixed(6)}" Importe="${money(c.importe)}"${c.discount ? ` Descuento="${money(c.discount)}"` : ""} ObjetoImp="02">
      <cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="${money(c.base)}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${money(c.iva)}"/></cfdi:Traslados></cfdi:Impuestos>
    </cfdi:Concepto>`,
    )
    .join("\n");

  const banner = opts.sandbox ? "<!-- PRUEBA — sin validez fiscal: documento no timbrado por un PAC -->\n" : "";
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
${banner}<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Serie="${esc(input.serie)}" Folio="${input.folio}" Fecha="${stamp(input.fecha)}" FormaPago="${input.formaPago}" SubTotal="${money(totals.subtotalCents)}"${totals.discountCents ? ` Descuento="${money(totals.discountCents)}"` : ""} Moneda="MXN" Total="${money(totals.totalCents)}" TipoDeComprobante="I" Exportacion="01" MetodoPago="${input.metodoPago}" LugarExpedicion="${esc(e.cp)}">
  <cfdi:Emisor Rfc="${esc(e.rfc)}" Nombre="${esc(e.nombre)}" RegimenFiscal="${esc(e.regimen)}"/>
  <cfdi:Receptor Rfc="${esc(r.rfc)}" Nombre="${esc(r.nombre)}" DomicilioFiscalReceptor="${esc(r.cp)}" RegimenFiscalReceptor="${esc(r.regimen)}" UsoCFDI="${esc(r.usoCfdi)}"/>
  <cfdi:Conceptos>
${conceptXml}
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="${money(totals.ivaCents)}">
    <cfdi:Traslados><cfdi:Traslado Base="${money(totals.baseCents)}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${money(totals.ivaCents)}"/></cfdi:Traslados>
  </cfdi:Impuestos>
</cfdi:Comprobante>
`;
  return { xml, totals };
}

/** Forma de pago SAT a partir de los métodos usados; con varios métodos distintos se usa 99 (por definir). */
export function formaPagoSat(methods: string[]): string {
  const map: Record<string, string> = { efectivo: "01", transferencia: "03", tarjeta: "04", qr: "31" };
  const uniq = [...new Set(methods)];
  return uniq.length === 1 ? (map[uniq[0]!] ?? "99") : "99";
}

export const RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i;
