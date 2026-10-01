import { photoSrc } from "./api";

export const ROLE_LABEL: Record<string, string> = {
  mesero: "Mesero", cajero: "Cajero", cocina: "Cocina", bar: "Barra", gerente: "Gerente",
  encargado_caja: "Encargado de caja", supervisor: "Supervisor", admin: "Administrador",
};

export const initials = (name: string) => name.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

/** Foto del trabajador; si no tiene, sus iniciales. */
export function UserAvatar({ name, photo, size = 40, active = false }: { name: string; photo?: string | null; size?: number; active?: boolean }) {
  const src = photoSrc(photo);
  return (
    <span className={`avatar${active ? " on" : ""}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}>
      {src ? <img src={src} alt="" /> : initials(name)}
    </span>
  );
}
