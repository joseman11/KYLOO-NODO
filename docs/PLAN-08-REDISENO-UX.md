# Plan 08 — Rediseño de experiencia de uso (UX/UI)

> **Etapa abierta** (2026-10-03, rama `feature/fundacion`). Pedido del dueño: «un rediseño a todo el sistema para cumplir estándares estrictos de UX/UI, a modo de que el sistema sea extremadamente cómodo de usar por los empleados, sin capacitación excesiva, y además se vea bonito y pulido.»
>
> Sistema visual vigente: [`DESIGN.md`](DESIGN.md) (se reescribe aquí a la v2). Las e2e son la red de seguridad: ningún cambio de UX se acepta con la suite en rojo.

## 1. Auditoría (capturas de la demo a 1280×800, 2026-10-03)

| # | Hallazgo | Estándar que incumple | Severidad |
|---|---|---|---|
| A1 | Al recargar con sesión abierta, un rol sin mesas (cocina, caja) cae en la pestaña «Mesas», que no puede usar. | Visibilidad del estado; prevención de errores | 🔴 |
| A2 | El naranja de marca se usa para la acción principal, para «ocupada», para bordes, insignias y 9 botones «Entregar» a la vez: nada destaca. | Jerarquía visual; una acción principal por región | 🔴 |
| A3 | El estado de la mesa se reconoce solo por un punto de color de 10 px (verde/naranja). | WCAG 1.4.1 (no solo color); reconocimiento antes que recuerdo | 🔴 |
| A4 | Textos de 11,5–13 px (menú lateral, tarjetas de mesa) y recortes con «…» («última comanda 9 …»). | Legibilidad táctil (mín. 14 px para lo que se lee a un brazo de distancia) | 🟠 |
| A5 | Botones «✕» que **borran sin confirmar** (categorías, productos, áreas) y sin texto. | Prevención de errores; control del usuario; confirmar lo destructivo | 🔴 |
| A6 | Títulos duplicados («Caja»/«Caja», «Pase»/«Pase») y abreviados («Config»). | Consistencia; lenguaje del usuario | 🟡 |
| A7 | Siete botones del mismo peso al pie de la cuenta; la acción más común (Cuenta) no se distingue. | Ley de Hick; jerarquía | 🟠 |
| A8 | Redundancia en Pase: «Todo listo» + «Listo» + «Entregar» dicen lo mismo tres veces. | Minimalismo | 🟡 |
| A9 | Sin ayuda en pantalla: quien llega nuevo no sabe qué tocar. | Ayuda y documentación; reconocer en vez de recordar | 🟠 |
| A10 | Sombras con resplandor naranja en botones y menú activo (decoración, no información). | Claridad | 🟡 |

## 2. Principios (reglas de aceptación)
1. **Una sola acción principal por región** (la única en naranja sólido). Lo repetido (p. ej. «Entregar» ×9) es secundario.
2. **El estado nunca se dice solo con color**: color + icono + palabra, siempre.
3. **Color con significado fijo:** naranja = *haz esto* (acción); verde = libre/listo/bien; azul = en curso/ocupada; ámbar = requiere atención pronto (cuenta pedida, tarda); rojo = error/retrasado/destructivo; gris = no disponible.
4. **Tamaños:** objetivo táctil ≥ 48 px (56 px operación); texto de lectura ≥ 14 px, metadatos ≥ 13 px; nada de 11 px.
5. **Nada destructivo sin confirmar**, con el nombre de lo que se borra; y cuando se pueda, **deshacer** en vez de preguntar.
6. **Lenguaje del restaurante**, sin siglas ni abreviaturas en títulos; verbos en infinitivo en botones («Enviar comanda», «Cobrar»).
7. **Ayuda donde se necesita:** una línea de guía por pantalla para quien llega nuevo (se oculta sola al usarla) y mensajes de vacío que dicen qué hacer.
8. **Entrada en la pantalla de su rol:** cada quien aterriza en lo suyo, también tras recargar.
9. **Accesibilidad verificable:** contraste AA, foco visible, nombres accesibles, `aria-live` en avisos, `prefers-reduced-motion`; se mide con `axe-core` en una e2e.

## 3. Orden
- [ ] **F8.1 — Sistema v2:** tokens semánticos, tipografía, botones, chips de estado, foco, movimiento (`styles.css`, `DESIGN.md`).
- [ ] **F8.2 — Componentes compartidos:** `StatusChip`, `Hint`, confirmación de borrado, iconos de estado.
- [ ] **F8.3 — Navegación y marco:** pestaña inicial por rol, títulos completos, menú lateral legible y agrupado, sin títulos duplicados.
- [ ] **F8.4 — Mesas y Pase:** tarjetas con estado claro, panel «Listos», Pase sin redundancia.
- [ ] **F8.5 — Cuenta y cobro:** jerarquía de acciones, estado por renglón, cobro guiado.
- [ ] **F8.6 — Cocina, Caja, Inventario, Configuración:** mismos patrones; borrados con confirmación.
- [ ] **F8.7 — Verificación:** capturas antes/después en 1280×800, 1024×600 y 820×1180; `axe-core`; e2e completas; `sin-scroll`.
- [ ] **F8.8 — Cierre.**

## 4. Registro
- **2026-10-03** — Apertura: auditoría con capturas de la demo (Mesas, cuenta, Caja, Pase, Configuración, ingreso).
