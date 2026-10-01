# 003 — Style Reference
> Papel blanco, una sola brasa — un instrumento de servicio donde un único naranja marca la siguiente acción.

**Theme:** light (KDS de cocina: dark)
**Base:** adaptación de `DESIGN-reference-brex.md` para tablets, pantallas táctiles y caja en red local.

## Tokens — Colors

| Name | Value | Token | Role |
|------|-------|-------|------|
| Ember | `#ff5900` | `--color-ember` | Única acción primaria por región (Enviar, Cobrar) y estados "requiere acción" |
| Abyss | `#000710` | `--color-abyss` | Fondo KDS, pantallas de estación |
| Carbon | `#15191e` | `--color-carbon` | Tarjetas de comanda en KDS, barra de estado del dispositivo |
| Ink | `#000000` | `--color-ink` | Títulos, cifras, texto principal |
| Paper | `#ffffff` | `--color-paper` | Lienzo y tarjetas |
| Fog | `#f3f3f7` | `--color-fog` | Fondos de sección, inputs, mesas disponibles |
| Mist | `#b9bbc6` | `--color-mist` | Bordes 1px, deshabilitado |
| Steel | `#8b8d98` | `--color-steel` | Iconos, placeholders |
| Pewter | `#6f737b` | `--color-pewter` | Texto auxiliar |
| Graphite | `#60646c` | `--color-graphite` | Texto secundario |

Sin segundo acento. Los estados de mesa y comanda se distinguen por **icono + etiqueta + escala de grises**; Ember solo en lo que exige acción inmediata (cuenta solicitada, comanda retrasada, impresora caída).

## Tokens — Typography
- **Inter** 400/500/600, tracking negativo: -0.01em ≤24px, -0.02em 36px, -0.03em 72px. `calt` y `liga` desactivados.
- Base táctil: **16px** mínimo en cualquier control. Cifras de cuenta y totales: 24–36px / 600 con `font-variant-numeric: tabular-nums`.
- Display (Flecha o sustituto) solo en pantallas de inicio/login, nunca en operación.

| Role | Size | Line | Weight |
|------|------|------|--------|
| caption | 12 | 1.5 | 500 |
| body-sm | 14 | 1.43 | 400 |
| body | 16 | 1.5 | 400 |
| subheading | 20 | 1.4 | 600 |
| heading-sm | 24 | 1.33 | 600 |
| heading | 36 | 1.21 | 600 |

## Spacing, Shapes & Touch
- Unidad 8px; escala 8 / 16 / 24 / 32 / 48 / 72.
- Radios: botones, inputs, tarjetas **12px**; tags 6px. Nunca 8 o 10px.
- **Objetivo táctil mínimo 48×48px**; botones de operación del mesero (productos, enviar, mesas) **56px+**; separación entre objetivos ≥ 8px.
- Padding de tarjeta 24px (16px en listas densas de comanda). Máx. ancho de página 1200px en admin; la operación usa todo el viewport.
- Sin sombras (solo modales/toasts). Profundidad = Paper sobre Fog + borde Mist.

## Components
- **Botón primario:** Ember, texto blanco, 12px, alto 56px (operación) / 40px (admin), Inter 600. Uno por región.
- **Botón secundario:** borde Mist 1px, texto Ink. **Ghost:** solo texto.
- **Tarjeta de mesa (mapa):** Paper, borde Mist; muestra número, mesero, tiempo de ocupación. Disponible = Fog; ocupada = borde Ink 2px; esperando pago = punto Ember + etiqueta; bloqueada = rayado gris.
- **Línea de comanda:** cantidad · nombre · modificadores en Graphite · nota en Pewter itálica; stepper ± de 48px.
- **Chip de modificador:** 6px radius, 40px alto, seleccionado = fondo Ink + texto Paper.
- **Ticket de estación (KDS):** fondo Carbon sobre Abyss, mesa en 36px/600, cronómetro (se vuelve Ember al exceder el tiempo objetivo), botón "Listo" Ember de ancho completo.
- **Barra de estado del dispositivo:** Carbon 32px; punto de conexión (conectado/offline), impresoras con error, usuario activo.
- **Teclado PIN:** cuadrícula 3×4 de botones 72px, Fog, radio 12px.
- **Toast/modal de autorización:** Paper, sombra única, pide PIN de gerente.

## Do's and Don'ts
**Do**
- Un solo Ember por región; el flujo principal es *mesa → productos → modificadores → Enviar*.
- Mostrar siempre el estado de conexión y de impresión; el error nunca es silencioso.
- Texto izquierda, cifras alineadas a la derecha en tabulares.
- Respuesta visual inmediata (optimista) al tocar; confirmar contra el servidor después.

**Don't**
- No añadir verde/rojo/azul para estados; usar iconos, etiquetas y Ember.
- No sombras de elevación, no radios mixtos, no objetivos < 48px.
- No hover como única señal (la pantalla es táctil); no gestos ocultos para acciones destructivas.
- No usar el tema oscuro fuera del KDS.

## Tailwind v4 / CSS
```css
:root {
  --color-ember:#ff5900; --color-abyss:#000710; --color-carbon:#15191e;
  --color-ink:#000; --color-paper:#fff; --color-fog:#f3f3f7;
  --color-mist:#b9bbc6; --color-steel:#8b8d98; --color-pewter:#6f737b; --color-graphite:#60646c;
  --font-inter:'Inter',ui-sans-serif,system-ui,sans-serif;
  --radius-card:12px; --radius-tag:6px;
  --touch-min:48px; --touch-primary:56px;
}
body { font-family:var(--font-inter); font-feature-settings:"calt" 0,"liga" 0; letter-spacing:-0.01em; }
```
