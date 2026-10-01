/**
 * Marcas internas de formato de los tickets. Son caracteres de control (no imprimibles) para que ningún
 * texto del usuario ni separador (`*`, `=`, `-`…) pueda confundirse con ellas.
 */
export const BOLD = "\u0001"; // al inicio de una línea: negritas
export const BIG = "\u0002"; // al inicio de una línea: negritas + doble alto y ancho

/** Quita las marcas (vista previa en pantalla). */
export const stripMarkup = (line: string) => line.replace(/^[\u0001\u0002]/, "");
