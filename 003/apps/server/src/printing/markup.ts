/**
 * Marcas internas de formato de los tickets. Son caracteres de control (no imprimibles) para que ningún
 * texto del usuario ni separador (`*`, `=`, `-`…) pueda confundirse con ellas.
 */
export const BOLD = "\u0001"; // al inicio de una línea: negritas
export const BIG = "\u0002"; // al inicio de una línea: negritas + doble alto y ancho
export const HUGE = "\u0003"; // al inicio de una línea: centrado, negritas y cuádruple alto y ancho (número de mesa)

export const DRAWER_PIN2 = "\u0004"; // línea completa: abre el cajón (pulso por el pin 2 del conector)
export const DRAWER_PIN5 = "\u0005"; // línea completa: abre el cajón (pulso por el pin 5)

/** Es una orden de abrir el cajón (no se imprime ni se muestra). */
export const isDrawerLine = (line: string) => line === DRAWER_PIN2 || line === DRAWER_PIN5;

/** Quita las marcas (vista previa en pantalla). Las órdenes de cajón no son texto y se descartan. */
export const stripMarkup = (line: string) => line.replace(/^[\u0001\u0002\u0003]/, "");
export const visibleLines = (lines: string[]) => lines.filter((l) => !isDrawerLine(l));
