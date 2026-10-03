# Nodo — Sistema de diseño v2
> Papel claro, un solo naranja para «haz esto», y colores con significado fijo para saber de un vistazo cómo está el servicio.

**Vigente desde el 2026-10-03 (plan 08).** Sustituye a la v1 («sin segundo acento»): en un restaurante hay que leer el estado de 15 mesas a un brazo de distancia y con prisa; el color con significado fijo, **siempre acompañado de icono y palabra**, lo hace más rápido y más seguro que la escala de grises. Referencia externa histórica: [`DESIGN-reference-brex.md`](DESIGN-reference-brex.md).

**Tema:** claro; la pantalla de cocina (KDS) es oscura.

## 1. Reglas de oro (se revisan en cada pantalla nueva)
1. **Una sola acción principal por región**, en naranja sólido (`.btn.primary`). Lo repetido (p. ej. «Entregar» ×9) no es principal.
2. **El estado nunca se dice solo con color**: color + icono + palabra (`StatusChip`).
3. **Reconocer antes que recordar:** etiquetas completas, sin siglas; los iconos acompañan al texto, no lo sustituyen.
4. **Nada destructivo sin confirmar**, diciendo qué se borra (`DeleteButton`); la opción segura toma el foco.
5. **Cada rol entra a su pantalla** y ve solo lo suyo.
6. **Guía una línea** donde se llega nuevo (`Hint`): aparece las primeras veces y se cierra para siempre.
7. **Nunca silencio:** conexión, impresión y errores siempre visibles y con qué hacer.
8. **Tocar, no apuntar:** objetivos grandes, sin hover como única señal, sin gestos ocultos.

## 2. Color con significado fijo

| Significado | Token | Uso | Texto sobre tinta |
|---|---|---|---|
| **Acción** (haz esto) | `--action` `#cf4500` | Botón principal, insignia de pendientes, selección | blanco (4,7:1) |
| **Libre / listo / bien** | `--ok-ink` `#067647` · `--ok-tint` | Mesa libre, plato listo, «Entregar», activo | 5,1:1 |
| **En curso / ocupada** | `--info` `#2563eb` · `--info-ink` `#1e429f` · `--info-tint` | Mesa ocupada, preparando, ayuda en pantalla | 7,7:1 |
| **Atención pronto** | `--color-gold`, `--warn-ink` `#8a4b00` · `--warn-tint` | Pide cuenta, inventario bajo, sin enviar | 6,2:1 |
| **Error / retrasado / borrar** | `--bad-ink` `#b42318` · `--bad-tint` | Sin conexión, retrasada, borrar | 5,8:1 |
| **No disponible** | `--color-steel`, rayado gris | Reservada, bloqueada | — |

Neutros: `--color-ink` (texto), `--color-graphite` (secundario, 6,6:1 sobre gris), `--color-pewter` (auxiliar, ≥ 4,5:1), `--color-mist` (bordes), `--color-fog`/`--color-cream` (fondos). KDS: `--color-abyss` y `--color-carbon`.

## 3. Tipografía
- **Inter** (texto) y **Bricolage Grotesque** (números de mesa, títulos). Tracking negativo en títulos.
- **Mínimos:** lectura 16 px; secundario 14 px; metadatos 13 px; **nada de 11 px**. Cifras de cuenta en tabulares (`.num`).
- Título de pantalla `h1.page-title` 26 px; solo uno por pantalla, **completo** (sin abreviar), el menú lateral usa la etiqueta corta.

## 4. Espacio, forma y toque
- Unidad 8 px. Radios: controles 14 px, tarjetas 20 px, píldoras 999 px.
- **Objetivo táctil:** ≥ 48 px de alto en operación (56 px el principal). Excepción documentada: el botón de papelera en tablas de administración (32 px de ancho, 40 de alto) para que quepa en pantallas de 1024 px; es intencionalmente pequeño y **siempre pide confirmación**.
- Separación entre objetivos ≥ 8 px.
- Elevación mínima (`--sh-1`/`--sh-2`); **sin resplandores de color**. La profundidad la da el papel blanco sobre el lienzo gris.

## 5. Componentes
- **Botón:** primario naranja sólido; `ok` verde (confirmaciones repetidas como «Entregar»); `danger` rojo (solo dentro de una confirmación); secundario blanco con borde; `ghost` solo texto.
- **Tarjeta de mesa:** barra de color a la izquierda + `StatusChip` (Libre / Ocupada / Pide cuenta / Reservada / Bloqueada) + dato en 14 px. «Tu mesa» lleva borde de tinta.
- **StatusChip:** icono + palabra, tono según §2. Es la única forma de mostrar un estado.
- **Hint:** una línea azul con «Entendido»; máximo 3 apariciones por pantalla.
- **Confirmación de borrado:** título «¿Eliminar la categoría «X»?», qué pasa, **Cancelar** con el foco y **Eliminar** en rojo.
- **Menú lateral:** icono + etiqueta de 13 px; activo en tinta con marca naranja; separador entre *servicio* y *gestión*; en pantallas bajas (< 700 px) se compacta para que quepan los 11 módulos.
- **KDS:** tickets sobre carbón; «Preparar» neutro y «Listo» verde; retrasada (> 15 min) en rojo con la palabra «Retrasada».
- **Ventanas (`.sheet`):** cierran con clic en el fondo o Escape (`backdrop()`); `role="dialog"`.

## 6. Accesibilidad (se mide)
- `axe-core` en `e2e/tests/accesibilidad.test.ts` revisa WCAG 2.1 AA en acceso, mesas, pase, caja, cocina, inventario, configuración, administración y comandero: **cero hallazgos serios**.
- Foco visible azul (`--focus`) en todo; nombres accesibles en botones de icono; `prefers-reduced-motion` respetado.
- Contraste de texto ≥ 4,5:1 (3:1 en texto grande).

## 7. Lo que NO se hace
- No usar naranja para estados, bordes o decoración.
- No mostrar un estado solo con color, ni solo con icono.
- No borrar al primer toque; no usar `prompt()`, `confirm()` ni `alert()` del navegador.
- No abreviar títulos de pantalla ni textos de botones.
- No textos de menos de 13 px; no recortar con «…» datos que decidan una acción (mesa, importe, estado).
