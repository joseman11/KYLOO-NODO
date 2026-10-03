# Plan 06 — App envoltorio para tablets (Android)

> **Etapa abierta** (2026-10-03, rama `feature/fundacion`). Resuelve D11 de [`PLAN-00`](PLAN-00-ESTRUCTURA-DE-TRABAJO.md) (E13 y E14 de [`ESTADO-ACTUAL`](ESTADO-ACTUAL.md)): una tablet que **recarga o se abre sin red** debe seguir funcionando.
>
> **Se sigue estrictamente.** Una sesión que retome esto lo lee entero y marca la casilla de cada fase, con su commit, al cerrarla.
>
> ### Cómo empieza la sesión que lo retome
> 1. Leer este documento, `docs/deploy/RED-LOCAL.md` y `docs/deploy/APP-TABLET.md`.
> 2. `git status`, `git log --oneline -20`.
> 3. Reverificar: `cd 003 && npx -y pnpm@11.21.0 --filter @003/server test`; para el APK ver `APP-TABLET.md`.

## 0. El encargo, literal y resumido

> «Prefiero app envoltorio.» (2026-10-03, sobre D11: HTTPS local frente a una app que envuelva la interfaz)

Resumen: una app instalable en las tablets que lleva **la interfaz dentro** (siempre disponible, con o sin red) y habla con el servidor del local por la red local.

## 1. Lo que hay hoy (mapa verificado, 2026-10-03)

- La interfaz web la sirve el propio servidor por `http://<ip>:3003`: en ese origen el navegador no activa el *service worker*, así que recargar sin red deja la pantalla en blanco (E13).
- El cliente llama al servidor con rutas relativas (`fetch("/api/…")`, WebSocket a `location.host`).
- Hay Android Studio, el SDK (plataformas 36/37) y un emulador `Pixel_7` en este equipo.

## 2. Decisiones

**D6.1 — Capacitor, no Tauri móvil.** Capacitor es la opción madura para «una app Android que carga una interfaz web propia»; Tauri móvil es más joven y su ventaja (Rust) no se usa aquí. Descartado también: un navegador en modo kiosco (no resuelve la recarga sin red).

**D6.2 — La interfaz va empaquetada en la app y los datos vienen del servidor.** El WebView carga la UI desde los archivos de la app (origen `http://localhost`, que **sí** es un contexto seguro) y llama a `http://<ip-del-servidor>:3003`. Así abrir o recargar la app sin red siempre funciona, y la cola de comandas pendientes sigue ahí. El servidor acepta ese origen por CORS (lista cerrada, no `*`).

**D6.3 — Pantalla de conexión.** La primera vez la app pide el servidor (IP y puerto, o escanear el QR de *Configuración → Conectar*), lo prueba contra `/api/health` y lo recuerda. Se puede cambiar desde el acceso.

**D6.4 — Compatibilidad app–servidor por versión de contrato.** `/api/health` publica la versión; si la app (que lleva su UI) es de otra versión mayor, avisa «actualiza la app» en vez de fallar a medias.

**D6.5 — Android primero.** Las tablets económicas son Android. iOS (necesita Xcode y cuenta de Apple Developer) queda para cuando haya un cliente que lo pida.

## 3. Invariantes

- **I6.1.** Sin la app, la web servida por el servidor sigue funcionando igual (PC de caja, un celular prestado).
- **I6.2.** Ninguna llamada de la interfaz se hace con un origen escrito a mano: todas salen de `serverBase()`.
- **I6.3.** CORS solo para orígenes de la app (lista cerrada).

## 4. Orden

- [ ] **F6.1 — Servidor:** CORS con lista cerrada y publicación de la versión de contrato.
- [ ] **F6.2 — Interfaz:** base del servidor configurable (HTTP, fotos, WebSocket, enlaces) y pantalla de conexión.
- [ ] **F6.3 — Prueba de origen cruzado** (e2e): la UI desde otro origen contra el servidor real.
- [ ] **F6.4 — Proyecto Android** (`003/apps/mobile`): Capacitor, pantalla siempre encendida, orientación libre, tráfico en claro permitido solo a la red local.
- [ ] **F6.5 — APK:** compilar y **probar en el emulador** (conectar, entrar, pedir, cortar la red y recargar).
- [ ] **F6.6 — Documentación y cierre.**

## 5. Decidido con el dueño

2026-10-03: app envoltorio en lugar de HTTPS local (D11).

## 6. Registro

*(se rellena al cerrar cada fase)*
