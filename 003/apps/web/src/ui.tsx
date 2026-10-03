import { type ReactNode, useEffect, useState } from "react";
import { backdrop } from "./sheet";
import { Icon } from "./icons";

/** Significado fijo de cada color (ver docs/DESIGN.md): nunca se usa solo, siempre con icono y palabra. */
export type Tone = "ok" | "info" | "warn" | "bad" | "mute" | "brand";

/** Estado con icono y palabra: se entiende sin distinguir colores. */
export function StatusChip({
  tone,
  icon,
  children,
}: {
  tone: Tone;
  icon?: string;
  children: ReactNode;
}) {
  return (
    <span className={`status-chip ${tone}`}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </span>
  );
}

const hintKey = (id: string) => `003.hint.${id}`;
const readHint = (id: string) => {
  try {
    return localStorage.getItem(hintKey(id));
  } catch {
    return null;
  }
};

/**
 * Una línea de guía para quien llega nuevo a una pantalla. Aparece las primeras veces y se puede cerrar para siempre;
 * al cerrarla o usarla (`dismissOnUse`) no vuelve. Nunca ocupa más de una línea ni empuja el contenido en un lado.
 */
export function Hint({ id, children, max = 3 }: { id: string; children: ReactNode; max?: number }) {
  const [shown, setShown] = useState(() => Number(readHint(id) ?? 0) < max);
  useEffect(() => {
    if (!shown) return;
    try {
      localStorage.setItem(hintKey(id), String(Number(readHint(id) ?? 0) + 1));
    } catch {
      /* sin almacenamiento: la guía se queda visible esta vez */
    }
  }, [shown, id]);
  if (!shown) return null;
  return (
    <div className="hint" role="note">
      <Icon name="ayuda" size={18} />
      <span className="grow">{children}</span>
      <button
        type="button"
        className="btn ghost sm"
        aria-label="Entendido, no mostrar más esta guía"
        onClick={() => {
          try {
            localStorage.setItem(hintKey(id), String(max));
          } catch {
            /* nada */
          }
          setShown(false);
        }}
      >
        Entendido
      </button>
    </div>
  );
}

/**
 * Botón de borrado: nunca borra al primer toque. Abre una confirmación que dice **qué** se borra y que no se puede
 * deshacer, con el botón de borrar en rojo y «Cancelar» como opción por defecto.
 */
export function DeleteButton({
  what,
  label = "Eliminar",
  onConfirm,
  iconOnly = true,
  detail,
}: {
  /** Nombre de lo que se borra, p. ej. «la categoría Postres». */
  what: string;
  label?: string;
  onConfirm: () => unknown | Promise<unknown>;
  iconOnly?: boolean;
  detail?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`btn ghost sm danger-text ${iconOnly ? "icon-only" : ""}`}
        aria-label={`${label} ${what}`}
        title={`${label} ${what}`}
        onClick={() => setOpen(true)}
      >
        <Icon name="basura" size={18} />
        {!iconOnly && <span>{label}</span>}
      </button>
      {open && (
        <div className="sheet-bg" {...backdrop(() => !busy && setOpen(false))}>
          <div className="sheet center confirm" role="alertdialog" aria-modal="true">
            <h3>
              ¿{label} {what}?
            </h3>
            <p className="muted">{detail ?? "Esta acción no se puede deshacer."}</p>
            <div className="row" style={{ gap: 10, justifyContent: "flex-end" }}>
              {/* biome-ignore lint/a11y/noAutofocus: la opción segura es la que toma el foco */}
              <button type="button" className="btn" autoFocus onClick={() => setOpen(false)}>
                Cancelar
              </button>
              <button
                type="button"
                className="btn danger"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onConfirm();
                  } finally {
                    setBusy(false);
                    setOpen(false);
                  }
                }}
              >
                {label}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
