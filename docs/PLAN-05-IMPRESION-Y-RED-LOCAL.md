# Plan 05 — Impresión (cajón y descubrimiento), conexión de tablets y cliente sin conexión

> **Etapa abierta** (2026-10-03, rama `feature/fundacion`). Continúa a [`PLAN-04`](PLAN-04-RESPALDO-EN-NUBE.md). Resuelve E13 a E17 de [`ESTADO-ACTUAL`](ESTADO-ACTUAL.md) y las decisiones D11 y D12 de [`PLAN-00`](PLAN-00-ESTRUCTURA-DE-TRABAJO.md) en lo que se puede construir y probar sin tablets físicas.
>
> 🤖 Sesión autónoma (el dueño duerme): lo abierto lo decide la sesión y queda en el Registro.
>
> **Se sigue estrictamente.** Una sesión que retome esto lo lee entero y marca la casilla de cada fase, con su commit, al cerrarla.
>
> ### Cómo empieza la sesión que lo retome
> 1. Leer este documento, `PLAN-00` §2 (D11, D12) y `ESTADO-ACTUAL.md` (E13 a E17).
> 2. `git status`, `git log --oneline -20`.
> 3. Reverificar: `cd 003 && npx -y pnpm@11.21.0 --filter @003/server test` (438 en verde al abrir este plan).

## 0. El encargo, literal y resumido

> «Impresoras por red / conectadas a ethernet.» · «Bluetooth, como plan a futuro, no necesario en esta MVP.» · «El resto de cosas no las limites bajo el pretexto de que es una MVP: planeamos construirlo y bien construido desde el inicio.» (2026-10-03)

> «¿Cómo manejaríamos si la tableta se queda sin conexión a mitad de una orden?» (2026-10-03)

Resumen: que la impresión de red sea completa (cajón de dinero, encontrar impresoras sin teclear IPs, estado visible), que conectar una tablet sea escanear un código, y que una tablet que pierde el WiFi siga tomando pedidos sin perder nada.

## 1. Lo que hay hoy (mapa verificado, 2026-10-03)

- Impresión: TCP 9100 con cola persistente, reintento (hasta 30 s) y paso a impresora de respaldo; **sin apertura de cajón**, sin búsqueda de impresoras, estado solo por consulta (`GET /api/printers/status`).
- Cliente: cola sin conexión en `localStorage` solo para `order` y `request_bill`; el servidor ya soporta `open_table`. Los datos de referencia se guardan con `useLive(…, cacheKey)` en `localStorage`.
- `sw.js` solo se registra en contexto seguro y la LAN es `http://`.
- Sin descubrimiento del servidor: se teclea la IP.

## 2. Decisiones

**D5.1 — Cajón por la impresora (pulso ESC/POS `ESC p`)**, que es como se conectan los cajones de monedero (RJ11 a la impresora). Una columna `has_drawer` por impresora; se abre solo con un cobro **en efectivo** (y con permiso, a mano). Va por la **misma cola** que los tickets (reintento y respaldo incluidos): un cajón que no abre por la red no se pierde en silencio.

**D5.2 — Descubrimiento por escaneo del puerto 9100** en las subredes del equipo (hasta /24 por interfaz), con tope de concurrencia y tiempo, y marcando las ya configuradas. Descartado: SNMP o mDNS de impresoras (la mayoría de térmicas baratas no los hablan).

**D5.3 — Conectar una tablet = escanear un QR o abrir `nodo.local`.** El servidor anuncia `nodo.local` por mDNS y publica sus direcciones; la pantalla muestra los códigos QR. Descartado: pedir al instalador que escriba IPs a mano en cada tablet.

**D5.4 — El cliente guarda en IndexedDB** (no `localStorage`): cola de operaciones completa y durable (abrir mesa, pedir, pedir cuenta) con id por operación, y las referencias (menú, mesas) con versión. Indicador visible de «sin conexión» y de cuántas operaciones esperan; un conflicto al reenviar (mesa ocupada, producto agotado) se muestra, no se descarta.

**D5.5 — HTTPS local con una CA propia queda como etapa aparte** (necesita decidir librería y probar en tablets reales, D11): esta etapa no lo construye y lo deja escrito. Lo que sí se hace: que el cliente funcione **sin** service worker (con la app en memoria y IndexedDB), que es lo que hay en `http://`.

## 3. Invariantes

- **I5.1.** Un cobro nunca falla porque el cajón no abra o la impresora no responda.
- **I5.2.** Reenviar una operación sin conexión nunca duplica una comanda ni abre dos veces una mesa.
- **I5.3.** Nada de lo pendiente se pierde al recargar la página o cerrar el navegador.
- **I5.4.** La red local sigue siendo suficiente: nada de esto exige Internet.

## 4. Orden

- [ ] **F5.1 — Cajón de dinero:** columna, pulso, apertura automática en cobros en efectivo, ruta manual, pruebas.
- [ ] **F5.2 — Descubrimiento de impresoras** (escaneo) y estado enriquecido.
- [ ] **F5.3 — Pantalla de impresoras:** buscar en la red, usar una encontrada, cajón y «abrir cajón».
- [ ] **F5.4 — Conexión de tablets:** mDNS, direcciones del servidor y QR en pantalla.
- [ ] **F5.5 — Cliente sin conexión:** IndexedDB, cola completa, referencias, indicador, conflictos.
- [ ] **F5.6 — Documentación y cierre** (incluye lo pendiente de D11 y el HTTPS local).

## 5. Decidido con el dueño

`PLAN-00` §5: impresoras por red (USB fuera), Bluetooth fuera, sin recortes por «MVP».

## 6. Registro

*(se rellena al cerrar cada fase)*
