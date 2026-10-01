# Investigación de comanderos: funciones y distribuciones de pantalla

Fecha: 1 de octubre de 2026. Alcance: lo que publican los fabricantes y guías comparativas (sus páginas de ayuda y artículos); no probé los productos. Donde una cifra o función viene de una guía comparativa, puede cambiar con el plan contratado.

## Fuentes
- Comparativas generales: [Toast vs Square vs Lightspeed 2026](https://www.dineopen.com/vs/toast-vs-square-vs-lightspeed), [TouchBistro vs Lightspeed](https://www.touchbistro.com/blog/touchbistro-vs-lightspeed/), [9 mejores POS para restaurantes](https://www.owner.com/blog/best-pos-system-for-restaurants).
- Mapa de mesas: [Square, crear el plano](https://squareup.com/help/us/en/article/6427-building-your-floor-plan).
- México: [SoftRestaurant, funciones](https://spconsult.com.mx/5-funciones-de-soft-restaurant/), [Áreas de servicio (manual)](https://webrestaurant.webhop.net/manual/Modulo%20Administrativo/areas-de-servicio/), [Parrot KDS](https://parrotsoftware.com.mx/blog/kitchen-display-system-kds-restaurante), [Fudo](https://fu.do/es-mx/).
- Pantalla de comanda: [Toast, pantallas de pedido](https://support.toasttab.com/en/article/New-POS-Experience-Ordering-Screens).
- Funciones imprescindibles: [15 funciones del POS de restaurante](https://aireuspos.com/restaurant-pos-system-features/), [qué buscar en un POS de servicio a mesa](https://www.applegazette.com/resources/what-table-service-restaurants-should-look-for-in-a-pos-system).
- Diseño: [10 tácticas de UX para POS](https://dev.pro/insights/designing-a-pos-system-ten-user-experience-tactics-that-improve-usability/), [diseño de plano de restaurante](https://www.therestauranthq.com/restaurants/restaurant-floor-plan/).

## Funciones que ofrecen y dónde está 003

| Función (quién la ofrece) | 003 hoy |
|---|---|
| Plano visual de mesas con formas y posición (Square, SoftRestaurant) | **Parcial**: áreas con mesas en cuadrícula; no hay plano arrastrable |
| Mesas por área / sección con reportes por área (Square, WebRestaurant) | **Sí** (áreas, prefijo, mesas); falta reporte de ventas por área |
| Unir mesas para grupos grandes (Square) | **Sí** |
| Tiempo desde que se abrió la cuenta y de la última comanda, y consumo promedio en el mapa (SoftRestaurant) | **Parcial**: tiempo y total; falta "última comanda" y promedio por persona |
| Accesos directos a los productos más vendidos por mesero (SoftRestaurant "comandero") | **Falta** |
| Buscador de productos en la pantalla de pedido (Toast) | **Falta** |
| Tiempos / "fire course" (Toast, Lightspeed) | **Parcial**: separadores por tiempo en la comanda; falta retener y mandar a cocina cuando se pida ("hold & fire") |
| Número de asiento y dividir por asiento (Toast, Lightspeed) | **Falta** (hay dividir por producto) |
| Dividir en partes iguales (SoftRestaurant) | **Falta** |
| KDS con cronómetro, color por demora, estaciones, pase | **Sí** (cronómetro, retraso, estaciones); falta pantalla de pase/expo y "recuperar" |
| Producto agotado ("86") sincronizado al instante | **Sí** |
| Cobro en la mesa desde el celular o tablet | **Falta** (se cobra en caja) |
| Reparto y pool de propinas por rol (SoftRestaurant, Toast) | **Parcial**: se registran; falta la regla de reparto |
| Checador de personal y turnos | **Falta** |
| Tarjetas de regalo y lealtad | **Falta** |
| Cargo por servicio automático (grupos grandes) | **Falta** |
| Pedidos en línea, QR y apps de delivery en la misma pantalla (Parrot, Fudo) | **Sí** (QR, API y delivery) |
| Inventario con recetas y costo (Lightspeed) | **Sí** |
| Modo sin conexión (Toast, otros "limitado") | **Parcial**: comandas y cuenta sin red |
| Varias sucursales (Lightspeed) | **Sí** |
| Sugerencias de venta cruzada (guías de UX) | **Falta** |
| Colores o formas por categoría para ubicar rápido (Toast, guías de UX) | **Falta** (003 usa un solo acento) |
| Modo claro y oscuro (guías de UX) | **Parcial** (oscuro solo en cocina) |

## Distribuciones de pantalla: opciones

### A. Cuenta a la izquierda + cuadrícula (la que tiene 003, estilo SoftRestaurant / Toast)
```
┌──────────────┬───────────────────────────────┐
│ Mesa T3  ←   │ [Todo][Tacos][Fuertes][Bebidas]│
│ 2 Taco calam │ ┌────┐┌────┐┌────┐┌────┐       │
│ 1 Arrachera  │ │    ││    ││    ││    │       │
│ ── POSTRE ── │ └────┘└────┘└────┘└────┘       │
│              │ ┌────┐┌────┐┌────┐┌────┐       │
│ TOTAL  $375  │ └────┘└────┘└────┘└────┘       │
│ [ENVIAR]     │ [Cuenta][Desc][Sep][Dividir]…  │
└──────────────┴───────────────────────────────┘
```
- A favor: ya existe, curva de aprendizaje baja para quien viene de SoftRestaurant, se ve toda la cuenta.
- En contra: en celular la cuenta ocupa demasiado.

### B. Plano visual con la cuenta en un panel lateral (estilo Square / TouchBistro)
```
┌───────────────────────────────┬─────────────┐
│ [Salón][Terraza][Barra]       │ Mesa T3     │
│  ┌──┐  ┌──┐   ○ ○            │ 2 Taco …    │
│  │T1│  │T2│  ○ T4 ○          │ 1 Arrachera │
│  └──┘  └──┘   ○ ○            │ [+ Producto]│
│   (arrastrar para acomodar)   │ [Cobrar]    │
└───────────────────────────────┴─────────────┘
```
- A favor: es lo que el mesero ve en el restaurante real; el mapa nunca desaparece; permite ver tiempos y consumo sobre cada mesa.
- En contra: hay que construir el editor del plano (formas, arrastrar, guardar posiciones); mesas muy pegadas son difíciles de tocar en pantallas chicas.

### C. Riel vertical de categorías (estilo iPad: TouchBistro / Lightspeed)
```
┌────┬──────────────────────────┬─────────────┐
│Tac │ Taco de calamar   $85    │ Cuenta      │
│Fue │ Taco al pastor    $45    │ …           │
│Beb │ Taco de pulpo     $95    │             │
│Pos │ (lista o botones)        │ [ENVIAR]    │
└────┴──────────────────────────┴─────────────┘
```
- A favor: caben muchas categorías sin filas de pestañas; buena para tabletas en vertical; la categoría activa siempre a la vista.
- En contra: menos productos visibles a la vez; hay que adaptar subcategorías.

### D. Por asientos y tiempos (restaurante de servicio fino)
```
┌───────────────────────────────────────────┐
│ Asiento: [1][2][3][4]   Tiempo: [1][2][3] │
│ ┌ Asiento 1 · Tiempo 1 ┐ ┌ Asiento 2 …  ┐ │
│ │ Taco calamar         │ │ Sopa         │ │
│ └──────────────────────┘ └──────────────┘ │
│ [Mandar tiempo 2]  [Dividir por asiento]  │
└───────────────────────────────────────────┘
```
- A favor: lo que piden los restaurantes con varios tiempos; dividir la cuenta por asiento sale exacto.
- En contra: más pasos por comanda; no conviene para taquerías o servicio rápido.

### E. Mano / celular (estilo Toast Go)
- Lista de la cuenta arriba y las funciones secundarias (descuento, dividir, cargo) en un menú "más".
- A favor: mesero camina con el celular. En contra: es otro diseño que mantener.

## Recomendación
1. Mantener **A** como pantalla principal (ya la conocen los meseros de SoftRestaurant).
2. Agregar el **plano visual (B)** como segunda vista del mapa de mesas: es lo que más piden los restaurantes con varias áreas, y la base (áreas, mesas, posiciones `pos_x`/`pos_y`) ya existe.
3. Dejar **C** como variante automática para tabletas en vertical y **E** para celular.
4. Priorizar estas funciones faltantes, en este orden: buscador de productos y favoritos por mesero; dividir en partes iguales; "última comanda" y consumo promedio en el mapa; retener y mandar tiempos a cocina; reparto de propinas; pantalla de pase en cocina; asientos (solo si se elige D).
5. Color por categoría: es opcional y choca con la regla de un solo acento de `docs/DESIGN.md`; si se quiere, que sea un punto de color pequeño en el botón, no el fondo.
