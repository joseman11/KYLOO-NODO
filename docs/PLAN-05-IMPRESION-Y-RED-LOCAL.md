# Plan 05 — Impresión (cajón y descubrimiento), conexión de tablets y cliente sin conexión

> **Etapa cerrada** (2026-10-03, rama `feature/fundacion`). Continúa a [`PLAN-04`](PLAN-04-RESPALDO-EN-NUBE.md). Resuelve E13 a E17 de [`ESTADO-ACTUAL`](ESTADO-ACTUAL.md) y las decisiones D11 y D12 de [`PLAN-00`](PLAN-00-ESTRUCTURA-DE-TRABAJO.md) en lo que se puede construir y probar sin tablets físicas.
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

- [x] **F5.1 — Cajón de dinero:** columna, pulso, apertura automática en cobros en efectivo, ruta manual, pruebas.
- [x] **F5.2 — Descubrimiento de impresoras** (escaneo) y estado enriquecido.
- [x] **F5.3 — Pantalla de impresoras:** buscar en la red, usar una encontrada, cajón y «abrir cajón».
- [x] **F5.4 — Conexión de tablets:** mDNS, direcciones del servidor y QR en pantalla.
- [x] **F5.5 — Cliente sin conexión:** IndexedDB, cola completa, referencias, indicador, conflictos.
- [x] **F5.6 — Documentación y cierre** (incluye lo pendiente de D11 y el HTTPS local).

## 5. Decidido con el dueño

`PLAN-00` §5: impresoras por red (USB fuera), Bluetooth fuera, sin recortes por «MVP».

## 6. Registro

- **2026-10-03 (noche, sesión autónoma)** — Cierre del plan.
  - **Hecho:** F5.1 `57a618a`; F5.2–F5.3 `ce69702`; F5.4 `69f9fcc`; F5.5 y F5.6 en el commit de cierre.
  - **Probado:** 22 pruebas de servidor nuevas (cajón: pulso, cobros en efectivo/tarjeta, pin, cola con impresora caída, ruta manual y permisos; búsqueda de impresoras con escucha real en un puerto; mDNS), también en PostgreSQL; 7 e2e nuevas (prueba de impresión, cajón de punta a punta, búsqueda y alta, pantalla Conectar con QR, **mesa y comanda sin conexión**, recarga con lo pendiente, reconexión y conflicto de mesa ocupada). `ping nodo.local` y `dns-sd` ven el servicio en macOS.
  - **Medido:** suite completa tras el plan: 460 (SQLite) y 461 (PostgreSQL) de servidor, 110/110 e2e.
  - **Salió por el camino:**
    - Se detectó una promesa rechazada sin atender al abrir una mesa sin red (`useLive.reload`): se endureció para que ningún `reload` sin red deje un error sin atender.
    - Una tablet que nunca abrió el comandero no tenía el menú en caché: ahora se precarga al entrar y al reconectar (`prefetchReference`, `loadCatalog` compartido para no duplicar el contrato).
    - El orden importa: si hay operaciones esperando, una nueva va detrás y se vacía la cola; antes podía adelantarse una comanda a la apertura de su mesa.
    - La limpieza de la cola solo quita lo enviado (antes `writeQueue([])` podía borrar una operación que entró mientras se esperaba la respuesta).
    - La prueba de «sin scroll» recorrió sola la pestaña nueva *Conectar* y las nuevas barras de Impresoras: lo que debe hacer.
  - **Decisiones tomadas por la sesión:** D5.1 a D5.5. **No se construyó** el HTTPS local ni el cliente con IndexedDB: HTTPS depende de D11 (decidir con una tablet real) y `localStorage` alcanza para una noche de comandas; ambos quedan escritos en «Pendiente».
  - **Encontrado de paso, anterior a esta etapa y sin arreglar aquí:** el escaneo de impresoras recorre solo /24; las impresoras no muestran su estado en vivo en pantalla más allá de «Probar».
  - **Estado de la máquina:** `nodo-pg` sigue arriba; servidores de demo detenidos (se reinician al final de la sesión).

### Cómo retomarlo
Plan 05 cerrado. Quedan por planear: D11 (HTTPS local o envoltorio nativo, con una tablet real), D12(c) servidor de reserva, consola del HQ, auditoría de seguridad (D9) y piloto (D10).

### Pendiente
- 🔴 Probar con impresora, cajón y tablet físicos.
- 🔴 Recargar la página sin red (HTTPS local o envoltorio nativo, D11).
- 🟠 Servidor de reserva y aviso de «servidor caído» (D12c).
- 🟡 IndexedDB para colas largas; pin 5 y copias por impresora en pantalla; estado de impresoras en vivo.
