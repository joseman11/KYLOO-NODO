/**
 * Motor de enrutamiento de producción (sec. 12 / 88).
 * Función pura: recibe los ítems de una comanda y sus rutas, devuelve un ticket de producción por estación.
 */

export interface ProductionRoute {
  area: string;
  subarea: string;
  stationId: string;
  /** Impresoras destino en orden de prioridad: principal, secundaria... Vacío si la estación usa solo KDS. */
  printerIds: string[];
}

export interface OrderItem {
  id: string;
  productId: string;
  name: string;
  quantity: number;
  modifiers?: string[];
  note?: string;
  /** Tiempo o separador de la comanda (Entradas, Plato fuerte, Postre…): cada estación lo imprime en el mismo orden. */
  course?: string;
  /** Asiento de la mesa al que pertenece el producto. */
  seat?: number;
  /** Un producto puede ir a una o varias estaciones (RN-004), p. ej. combos. */
  routes: ProductionRoute[];
}

export interface ProductionTicketLine {
  itemId: string;
  name: string;
  quantity: number;
  modifiers: string[];
  note?: string;
  course?: string;
  seat?: number;
}

export interface ProductionTicket {
  stationId: string;
  area: string;
  subarea: string;
  printerIds: string[];
  lines: ProductionTicketLine[];
}

export class MissingRouteError extends Error {
  constructor(public readonly itemId: string, public readonly productName: string) {
    super(`El producto "${productName}" no tiene ruta de producción (RN-003)`);
  }
}

export function routeOrder(items: readonly OrderItem[]): ProductionTicket[] {
  const byStation = new Map<string, ProductionTicket>();

  for (const item of items) {
    if (item.routes.length === 0) throw new MissingRouteError(item.id, item.name);
    for (const route of item.routes) {
      let ticket = byStation.get(route.stationId);
      if (!ticket) {
        ticket = {
          stationId: route.stationId,
          area: route.area,
          subarea: route.subarea,
          printerIds: route.printerIds,
          lines: [],
        };
        byStation.set(route.stationId, ticket);
      }
      ticket.lines.push({
        itemId: item.id,
        name: item.name,
        quantity: item.quantity,
        modifiers: item.modifiers ?? [],
        ...(item.note ? { note: item.note } : {}),
        ...(item.course ? { course: item.course } : {}),
        ...(item.seat ? { seat: item.seat } : {}),
      });
    }
  }

  return [...byStation.values()];
}
