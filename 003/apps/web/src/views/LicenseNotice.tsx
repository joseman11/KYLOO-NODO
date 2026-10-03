import { useState } from "react";
import { api, can, useLive } from "../api";

interface Status {
  mode: "open" | "enforced";
  grace_days: number;
  license: {
    plan: string;
    expires_at: number;
    expired: boolean;
    restricted: boolean;
    reason: string | null;
  } | null;
}

const DAY = 86_400_000;
const dayKey = () => new Date().toISOString().slice(0, 10);

/**
 * Aviso de la suscripción en la barra superior, solo para quien administra (no se alarma al personal de servicio):
 * por vencer (30 días), vencida dentro de la gracia, o retirada/vencida del todo. Lo urgente no se puede ocultar; lo demás,
 * se cierra por hoy. En desarrollo (sin licencia) no aparece.
 */
export function LicenseNotice() {
  const status = useLive(() => api<Status>("/api/cloud/status"), []);
  const [hiddenFor, setHiddenFor] = useState(() => {
    try {
      return localStorage.getItem("003.license-notice");
    } catch {
      return null;
    }
  });
  const s = status.data;
  if (!can("user.manage") || !s?.license) return null;
  const l = s.license;
  const left = Math.ceil((l.expires_at - Date.now()) / DAY);

  let text: string | null = null;
  let urgent = false;
  if (l.restricted) {
    urgent = true;
    text =
      l.reason === "vencida"
        ? `La suscripción venció hace más de ${s.grace_days} días: el local trabaja con el plan gratuito. Renueva con Nodo para recuperar todas las funciones.`
        : l.reason === "revocada"
          ? "Nodo retiró la licencia de este local: trabaja con el plan gratuito. Contáctanos si crees que es un error."
          : s.mode === "enforced"
            ? "Este equipo no está activado: trabaja con el plan gratuito. Actívalo en Configuración → Nube y plan."
            : null;
  } else if (l.expired) {
    urgent = true;
    const graceLeft = Math.max(0, s.grace_days + Math.floor((l.expires_at - Date.now()) / DAY));
    text = `La suscripción venció: el servicio sigue completo ${graceLeft} día${graceLeft === 1 ? "" : "s"} más. Renueva con Nodo.`;
  } else if (left <= 30) {
    text = `Tu suscripción vence en ${Math.max(left, 0)} día${left === 1 ? "" : "s"}. Renueva con Nodo para no perder funciones.`;
  }
  if (!text || (!urgent && hiddenFor === dayKey())) return null;

  return (
    <div className="banner" role="status" data-license-notice={urgent ? "urgente" : "aviso"}>
      <span>{text}</span>
      {!urgent && (
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            try {
              localStorage.setItem("003.license-notice", dayKey());
            } catch {
              /* sin almacenamiento */
            }
            setHiddenFor(dayKey());
          }}
        >
          Cerrar por hoy
        </button>
      )}
    </div>
  );
}
