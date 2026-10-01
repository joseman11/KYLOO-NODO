/**
 * Logotipo de Nodo, 100 % vectorial (sin tipografías): letras de trazo grueso y redondeado, inclinadas
 * y con un ligero desajuste entre ellas; la última "o" es una sartén vista desde arriba con un huevo
 * (el punto naranja: el "nodo") en el centro.
 */
const PAN = (
  <>
    <circle cx="410" cy="100" r="40" />
    <line x1="448" y1="92" x2="526" y2="68" strokeWidth="24" />
  </>
);

export function NodoMark({ size = 32, color = "currentColor", accent = "#ff5900" }: { size?: number; color?: string; accent?: string }) {
  return (
    <svg width={size} height={size} viewBox="360 30 190 140" fill="none" aria-hidden="true" style={{ overflow: "visible" }}>
      <g stroke={color} strokeWidth="26" strokeLinecap="round" strokeLinejoin="round">{PAN}</g>
      <circle cx="410" cy="100" r="15" fill={accent} />
    </svg>
  );
}

export function NodoLogo({ size = 280, color = "currentColor", accent = "#ff5900" }: { size?: number | string; color?: string; accent?: string }) {
  return (
    <svg role="img" aria-label="Nodo" width={size} viewBox="0 0 590 190" fill="none" style={{ display: "block", overflow: "visible" }}>
      <g transform="translate(26 0) skewX(-9)" stroke={color} strokeWidth="26" strokeLinecap="round" strokeLinejoin="round">
        {/* N */}
        <g transform="rotate(-3 58 85)"><path d="M24 142 V30 L98 142 V30" /></g>
        {/* o */}
        <g transform="translate(0 -4) rotate(4 170 100)"><circle cx="170" cy="100" r="40" /></g>
        {/* d */}
        <g transform="rotate(-2 305 85)"><circle cx="285" cy="100" r="40" /><line x1="325" y1="18" x2="325" y2="140" /></g>
        {/* o = sartén con huevo */}
        <g transform="translate(0 4) rotate(3 410 100)">{PAN}<circle cx="410" cy="100" r="15" fill={accent} stroke="none" /></g>
      </g>
    </svg>
  );
}

/** Logotipo de Kyloo (vectorial, hereda el color del texto). */
export function KylooLogo({ width = 72 }: { width?: number }) {
  return (
    <svg role="img" aria-label="Kyloo" width={width} viewBox="0 0 214 80" fill="currentColor" style={{ display: "block" }}>
      <path d="M5.64 60L5.64 1.90L15.69 1.90L15.69 31.20L41.67 1.90L54.03 1.90L32.04 26.14L55.36 60L43.49 60L25.32 33.61L15.69 44.23L15.69 60" /><path d="M58.98 73.78L58.98 66.39L66.79 66.39Q68.69 66.39 69.69 65.81Q70.69 65.23 71.35 63.65L73.01 59.17L55.91 18.17L66.04 18.17L77.58 47.47L88.12 18.17L98.16 18.17L79.57 66.72Q77.99 70.96 75.38 72.37Q72.76 73.78 68.61 73.78" /><path d="M102.90 60L102.90 1.90L112.53 1.90L112.53 60" /><g transform="translate(122 18) scale(.5454545)"><path d="M38.5 77C59.763 77 77 59.763 77 38.5C77 17.237 59.763 0 38.5 0C17.237 0 0 17.237 0 38.5C0 59.763 17.237 77 38.5 77Z" /></g><g transform="translate(168 18) scale(.5454545)"><path fillRule="evenodd" d="M38.5 77C59.763 77 77 59.763 77 38.5C77 17.237 59.763 0 38.5 0C17.237 0 0 17.237 0 38.5C0 59.763 17.237 77 38.5 77ZM38.5 66C53.6878 66 66 53.6878 66 38.5C66 23.3122 53.6878 11 38.5 11C23.3122 11 11 23.3122 11 38.5C11 53.6878 23.3122 66 38.5 66Z"/><path d="M64.0695 0H77L12.7647 77H0L64.0695 0Z" /></g>
    </svg>
  );
}
