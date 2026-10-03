import type { KeyboardEvent, MouseEvent } from "react";

/**
 * Propiedades del fondo de una ventana modal (`.sheet-bg`): un clic sobre el fondo —no sobre la ventana— la cierra y la
 * tecla Escape también (llega desde el campo enfocado dentro de la ventana). La ventana interior lleva `role="dialog"`.
 *
 *   <div className="sheet-bg" {...backdrop(onClose)}>
 *     <div className="sheet" role="dialog" aria-modal="true"> … </div>
 *   </div>
 */
export const backdrop = (close: () => void) => ({
  role: "presentation" as const,
  onClick: (e: MouseEvent<HTMLElement>) => {
    if (e.target === e.currentTarget) close();
  },
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") close();
  },
});
