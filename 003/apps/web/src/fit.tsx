import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Sin scroll en pantalla: en vez de desplazarse, las listas se dividen en páginas según el
 * espacio disponible (se recalcula al girar la tablet o cambiar el tamaño de la ventana).
 */

const PAGER_H = 56;

/**
 * Hasta que el navegador mide el contenedor (primer cuadro) el tamaño es 0×0 y la paginación calcularía
 * «una fila por página»: se veía un parpadeo con páginas de más, muy visible en tablets lentas (a 8 cuadros
 * por segundo duraba más de 400 ms y hacía fallar las pruebas). Mientras no hay medida solo se pinta el contenedor.
 */
const unmeasured = (s: { w: number; h: number }) => s.h <= 0;

export function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(
      ([e]) =>
        e && setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

export function Pager({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (p: number) => void;
}) {
  return (
    <div className="pager">
      <button
        className="btn"
        disabled={page <= 0}
        onClick={() => onPage(page - 1)}
        aria-label="Página anterior"
      >
        ‹
      </button>
      <span className="num">
        {page + 1} / {pages}
      </span>
      <button
        className="btn"
        disabled={page >= pages - 1}
        onClick={() => onPage(page + 1)}
        aria-label="Página siguiente"
      >
        ›
      </button>
    </div>
  );
}

/** Divide `items` en páginas de `capacity`; devuelve la página actual (acotada) y su control. */
function usePaging<T>(items: T[], capacity: number) {
  const [page, setPage] = useState(0);
  const cap = Math.max(1, capacity);
  const pages = Math.max(1, Math.ceil(items.length / cap));
  const p = Math.min(page, pages - 1);
  return { page: p, pages, setPage, slice: items.slice(p * cap, (p + 1) * cap) };
}

/** Cuadrícula que llena el espacio: tarjetas de al menos minW×minH y paginación cuando no caben todas. */
export function PagedGrid<T>({
  items,
  minW,
  minH,
  gap = 12,
  render,
  empty,
}: {
  items: T[];
  minW: number;
  minH: number;
  gap?: number;
  render: (item: T) => ReactNode;
  empty?: ReactNode;
}) {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const fit = (hh: number) => ({
    cols: Math.max(1, Math.floor((w + gap) / (minW + gap))),
    rows: Math.max(1, Math.floor((hh + gap) / (minH + gap))),
  });
  let { cols, rows } = fit(h);
  const paged = items.length > cols * rows;
  if (paged) ({ cols, rows } = fit(h - PAGER_H));
  const { page, pages, setPage, slice } = usePaging(items, cols * rows);
  if (unmeasured({ w, h })) return <div ref={ref} className="fill" />;
  const gridH = paged ? h - PAGER_H : h;
  const used = Math.max(1, Math.ceil(slice.length / cols));

  return (
    <div ref={ref} className="fill">
      {items.length === 0 ? (
        (empty ?? null)
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gap,
              height: gridH > 0 ? gridH : undefined,
              gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))`,
              gridTemplateRows: `repeat(${Math.min(rows, Math.max(used, 1))}, minmax(0, ${minH + 40}px))`,
              alignContent: "start",
            }}
          >
            {slice.map((it, i) => (
              <div
                key={i}
                style={{ minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column" }}
              >
                {render(it)}
              </div>
            ))}
          </div>
          {paged && <Pager page={page} pages={pages} onPage={setPage} />}
        </>
      )}
    </div>
  );
}

/** Tabla/lista con filas de altura fija: muestra solo las que caben y pagina el resto. */
export function PagedRows<T>({
  items,
  rowH = 48,
  head,
  row,
  empty,
  fixed,
}: {
  items: T[];
  rowH?: number;
  head?: ReactNode;
  row: (item: T) => ReactNode;
  empty?: ReactNode;
  fixed?: boolean;
}) {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const headH = head ? 40 : 0;
  const fits = (hh: number) => Math.max(1, Math.floor((hh - headH) / rowH));
  const paged = items.length > fits(h);
  const { page, pages, setPage, slice } = usePaging(items, fits(paged ? h - PAGER_H : h));
  if (unmeasured({ w, h })) return <div ref={ref} className="fill" />;
  return (
    <div ref={ref} className="fill">
      {items.length === 0 ? (
        (empty ?? null)
      ) : (
        <>
          <table className="fixed" style={fixed ? { tableLayout: "fixed" } : undefined}>
            {head && <thead style={{ height: headH }}>{head}</thead>}
            <tbody>
              {slice.map((it, i) => (
                <tr key={i} style={{ height: rowH }}>
                  {row(it)}
                </tr>
              ))}
            </tbody>
          </table>
          {paged && <Pager page={page} pages={pages} onPage={setPage} />}
        </>
      )}
    </div>
  );
}

/** Para listas de bloques de altura variable (p. ej. tickets de cocina): llena columnas y pagina. */
export function PagedColumns<T>({
  items,
  colMinW,
  est,
  gap = 12,
  render,
  empty,
}: {
  items: T[];
  colMinW: number;
  est: (item: T) => number;
  gap?: number;
  render: (item: T) => ReactNode;
  empty?: ReactNode;
}) {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const cols = Math.max(1, Math.floor((w + gap) / (colMinW + gap)));
  const pack = (avail: number) => {
    const pages: T[][][] = [];
    let page: T[][] = Array.from({ length: cols }, () => []);
    let col = 0,
      used = 0;
    for (const it of items) {
      const hh = est(it);
      if (used > 0 && used + gap + hh > avail) {
        col++;
        used = 0;
        if (col >= cols) {
          pages.push(page);
          page = Array.from({ length: cols }, () => []);
          col = 0;
        }
      }
      page[col]!.push(it);
      used += (used ? gap : 0) + hh;
    }
    pages.push(page);
    return pages;
  };
  let pages = pack(h);
  const paged = pages.length > 1;
  if (paged) pages = pack(h - PAGER_H);
  const [page, setPage] = useState(0);
  const p = Math.min(page, pages.length - 1);
  if (unmeasured({ w, h })) return <div ref={ref} className="fill" />;

  return (
    <div ref={ref} className="fill">
      {items.length === 0 ? (
        (empty ?? null)
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gap,
              gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))`,
              height: paged ? h - PAGER_H : h,
              alignItems: "start",
              overflow: "hidden",
            }}
          >
            {pages[p]!.map((colItems, ci) => (
              <div key={ci} className="col" style={{ gap }}>
                {colItems.map((it, i) => (
                  <div key={i}>{render(it)}</div>
                ))}
              </div>
            ))}
          </div>
          {paged && <Pager page={p} pages={pages.length} onPage={setPage} />}
        </>
      )}
    </div>
  );
}

/** Pestañas internas: cada sección ocupa toda la pantalla, así nada se desplaza. */
export function SubTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  value: T;
  onChange: (t: T) => void;
}) {
  return (
    <div className="row wrap">
      {tabs.map((t) => (
        <button
          key={t.id}
          className={`chip ${value === t.id ? "on" : ""}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
