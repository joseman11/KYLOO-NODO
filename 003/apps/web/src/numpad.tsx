/** Teclado numérico táctil: para capturar números de mesa, personas o cantidades sin abrir el teclado del sistema. */
export function NumPad({
  value,
  onChange,
  max = 4,
}: {
  value: string;
  onChange: (v: string) => void;
  max?: number;
}) {
  const press = (d: string) => onChange((value === "0" ? d : value + d).slice(0, max));
  return (
    <div className="pad">
      {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
        <button type="button" key={d} className="btn" onClick={() => press(d)}>
          {d}
        </button>
      ))}
      <button
        type="button"
        className="btn"
        aria-label="Borrar"
        onClick={() => onChange(value.slice(0, -1))}
      >
        ⌫
      </button>
      <button type="button" className="btn" onClick={() => press("0")}>
        0
      </button>
      <button type="button" className="btn" aria-label="Limpiar" onClick={() => onChange("")}>
        C
      </button>
    </div>
  );
}
