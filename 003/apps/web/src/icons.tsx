import type { ReactNode } from "react";

/** Iconos de línea simples (24×24, trazo del color del texto). Sin dependencias externas. */
const PATHS: Record<string, ReactNode> = {
  mesas: (
    <>
      <rect x="3" y="7" width="18" height="4" rx="1.5" />
      <path d="M6 11v8M18 11v8M10 11v4M14 11v4" />
    </>
  ),
  pase: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M8 12.5l3 3 5-6" />
    </>
  ),
  llevar: (
    <>
      <path d="M6 8h12l-1 12H7L6 8z" />
      <path d="M9 8a3 3 0 016 0" />
    </>
  ),
  reservas: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  cocina: (
    <>
      <path d="M4 12h16v5a3 3 0 01-3 3H7a3 3 0 01-3-3v-5z" />
      <path d="M8 8c0-1.2 1-1.2 1-2.4M12 8c0-1.2 1-1.2 1-2.4M16 8c0-1.2 1-1.2 1-2.4" />
    </>
  ),
  caja: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2.5" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M6.5 9.5v.01M17.5 14.5v.01" />
    </>
  ),
  inventario: (
    <>
      <path d="M3.5 8L12 3.5 20.5 8v8L12 20.5 3.5 16V8z" />
      <path d="M3.5 8L12 12.5 20.5 8M12 12.5v8" />
    </>
  ),
  analitica: (
    <>
      <path d="M5 20V11M12 20V4M19 20v-6" />
    </>
  ),
  admin: (
    <>
      <rect x="3.5" y="3.5" width="7" height="9" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="5" rx="1.5" />
      <rect x="13.5" y="11.5" width="7" height="9" rx="1.5" />
      <rect x="3.5" y="15.5" width="7" height="5" rx="1.5" />
    </>
  ),
  config: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9M4 12h16" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  recetas: (
    <>
      <path d="M5 4.5h10a3 3 0 013 3V20H8a3 3 0 01-3-3V4.5z" />
      <path d="M8 20a3 3 0 01-3-3M9 8.5h6M9 12h6" />
    </>
  ),
  reloj: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  camara: (
    <>
      <path d="M4 8h3l1.5-2.5h7L17 8h3a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  buscar: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  estrella: (
    <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.3 2.8 1-5.9-4.2-4.1 5.9-.8L12 3.5z" />
  ),
  regalo: (
    <>
      <rect x="3.5" y="9" width="17" height="11" rx="2" />
      <path d="M3.5 13h17M12 9v11M12 9c-2-4-6-3-5 0 .5 1.5 3 1 5 0zM12 9c2-4 6-3 5 0-.5 1.5-3 1-5 0z" />
    </>
  ),
  personas: (
    <>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19c.5-3.2 2.7-5 5.5-5s5 1.8 5.5 5M16.5 6a3 3 0 010 5.8M18 14.2c1.8.6 2.7 2.2 3 4.8" />
    </>
  ),
};

export function Icon({ name, size = 24 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name] ?? PATHS.admin}
    </svg>
  );
}
