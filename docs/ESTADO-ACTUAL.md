# Estado actual de KYLOO-NODO

> Documento vivo. Fotografía **verificada el 2026-10-03** sobre `main` (`1b45563`), ejecutando el código en un equipo macOS con Node 24.21. Si discrepa del código, gana el código y se corrige este documento.

## 1. Qué es

**Nodo** es un comandero (punto de venta de restaurante) pensado para funcionar **sin internet**. Un servidor en el local es la fuente de verdad; tablets de meseros, pantallas de cocina y barra, y la caja son navegadores en la misma red local. Las impresoras térmicas se alcanzan desde el servidor por TCP 9100 (ESC/POS). Hay además una página de venta (`landing/`).

Aún **no tiene clientes**. El producto ya está muy avanzado en funciones (tres fases construidas) y casi no ha pasado por uso real.

## 2. Arquitectura

```text
Tablet / pantalla / caja / KDS  (navegador, PWA)
        │ HTTP + WebSocket (red local)
        ▼
Servidor local  (Node + Fastify)  ── SQLite (un archivo, WAL)
   ├─ motor de enrutamiento de producción (en packages/shared)
   ├─ cola de impresión persistente con reintento y failover
   ├─ hub de eventos en tiempo real (/ws?token=JWT)
   ├─ webhooks firmados y API de integraciones
   └─ sincronización opcional con HQ (nube)
        │ TCP 9100
        ▼
Impresoras térmicas
```

| Pieza | Tecnología | Tamaño (2026-10-03) |
|---|---|---|
| `003/apps/server` | Fastify 5, `better-sqlite3` 13, `@fastify/jwt`, `@fastify/websocket`, Zod, scrypt | 7.5k líneas, 51 archivos, 26 módulos de rutas, 62 tablas, 10 migraciones |
| `003/apps/web` | React 19, Vite 8, PWA (`sw.js` solo en contexto seguro), sin librería de UI | 5.2k líneas, 40 archivos, 28 vistas |
| `003/packages/shared` | Permisos, máquina de estados de comanda, motor de rutas | 220 líneas |
| Pruebas de servidor | Vitest, base `:memory:` | 3.8k líneas, 13 archivos, 350 pruebas |
| `003/apps/e2e` | puppeteer-core + Vitest, servidor real y demo | 1.3k líneas, 6 archivos, 92 pruebas |
| `landing/` | Next.js 15 (App Router, estática), videos `.mp4` renderizados desde HTML | 12 MB de videos; deploy en Railway |

Roles: `admin`, `gerente`, `encargado_caja`, `mesero`, `cajero`, `cocina`, `bar`, `supervisor`. Sesión: JWT de 12 h guardado en `localStorage` del navegador (aceptable en LAN; a revisar si el acceso sale de la red local).

## 3. Qué hace (módulos construidos)

- **Fase 1:** auth por PIN y por usuario/contraseña, mesas y zonas, catálogo con modificadores, comandas con máquina de estados, enrutamiento a estaciones, impresión con cola persistente y failover, caja (pagos mixtos idempotentes, propinas, cortes), auditoría, reportes y respaldo.
- **Fase 2:** inventario y recetas (descuento al enviar la comanda), proveedores y compras, descuentos con autorización y promociones, clientes, reservaciones, para llevar y delivery, menú QR por mesa.
- **Fase 3:** analítica, API de integraciones y webhooks firmados, sincronización offline por lotes, facturación electrónica **con proveedor de prueba**, HQ multi-organización, licencias firmadas por plan.
- **Posteriores:** áreas y categorías propias, tickets configurables, separadores y tiempos retenidos, fotos de platillos, pase de cocina, checador y propinas, tarjetas de regalo, inventario por áreas con límites, listas de compras compartibles, recetario.
- Detalle funcional en `003/README.md` y en los planes históricos (`PLAN-FASE1/2/3.md`).

## 4. Lo que ya existe de «nube» en `main` (y lo que no)

Existe un **servidor HQ** (`ROLE=hq`, `003/apps/server/src/routes/hq.ts`, `cloud.ts`): organizaciones, sucursales con llave, licencias firmadas y consola en `/hq`. La sucursal se vincula y cada hora (y 30 s tras arrancar) envía a HQ un **resumen diario de ventas de los últimos 7 días** y sincroniza catálogo; sin internet reintenta después.

**Lo que no hay:** un respaldo en nube de los datos del local. HQ recibe resúmenes de ventas y catálogo, no la base de datos ni las comandas. El único respaldo completo es el automático local (cada 24 h, últimos 14, en `data/backups`) y el manual desde Administración. Perder el equipo del local es perder los datos.

**Planes de licencia** (`license.ts`): `gratis` (1 sucursal, 3 usuarios, 1 impresora), `basico` (1/10/3, inventario y delivery), `profesional` (3/30/10, más QR, analítica, facturación, integraciones), `empresarial` (sin límites). Gracia de 7 días tras vencer; con la licencia vencida se aplican los límites del plan gratis, **nunca se detiene la venta**. La landing los llama INICIO / BÁSICO / PROFESIONAL / EMPRESARIAL: nombre distinto del código para el primero.

**Facturación:** sin proveedor de timbrado (PAC) las facturas son CFDI 4.0 de prueba, marcadas «PRUEBA — sin validez fiscal». Existe la interfaz `InvoiceProvider` (`routes/invoices.ts`: `stamp`, `cancel`) para conectar uno. Timbrar de verdad exige credenciales del PAC y, por la naturaleza del servicio, conectividad.

## 5. La rama `origin/nube-web` (integrada el 2026-10-03 en la rama de sesión, no en `main`)

Dos commits del 2026-10-01 sobre `main`, 64 archivos (+2965 −2312):

- `f4fb335` — **Capa de datos asíncrona (`Store`)** con motor SQLite: toda la aplicación pasa de la API síncrona de `better-sqlite3` a una interfaz asíncrona (`prepare().get/all/run`, `exec`, `transaction`).
- `64cce7d` — **Motor PostgreSQL** (`pg`): un **esquema por restaurante** en una base compartida (`search_path` fijo por conexión), dialecto SQL portable y migraciones propias (`store/pg*.ts`). La suite completa pasa en SQLite y en PostgreSQL (`NODO_PG_URL`).

Es decir, es la base técnica para correr **el mismo código** en el local (SQLite) y en una nube multi-restaurante (PostgreSQL). No incluye despliegue, interfaz web de nube ni sincronización de datos; solo la abstracción de datos y el segundo motor. Integrada en `feature/sesion-autonoma-2026-10-03` (merge `e6c9057`). Verificada: **350 pruebas de servidor en SQLite y 351 en PostgreSQL 16**. Sus cambios a las e2e no eran la causa de los rojos (esos eran de entorno, `CLAUDE.md` trampa 4). Lo que **aún no incluye:** despliegue, sincronización de datos ni interfaz de nube.

## 6. Verificación

**Al 2026-10-03, tras el plan 01** (rama `feature/sesion-autonoma-2026-10-03`):

| Chequeo | Resultado |
|---|---|
| `pnpm install` (pnpm 11.21.0) | ✅ |
| `tsc` en shared, server, web y e2e (`pnpm typecheck`) | ✅ |
| Pruebas de servidor en SQLite | ✅ 350 (+1 de PostgreSQL que se salta sin base) |
| Pruebas de servidor en PostgreSQL 16 (contenedor) | ✅ 351 |
| Pruebas de shared | ✅ 6 |
| e2e (92 pruebas, ~5 min) | ✅ 92/92 |
| Build de la web | ✅ JS 481 kB (135 kB gzip) |
| Build de la landing | ✅ Next 15.5.27 |
| Biome (formato y errores de lint) | ✅ sin errores; avisos de accesibilidad, `any` y dependencias de hooks quedan como deuda |
| Servidor con demo de mariscos | ✅ 93 MB de RAM en reposo; ~1.5k peticiones/s en un reporte real (p50 5 ms) |

*Antes del plan 01 (`main`, 2026-10-03 por la mañana):* 356/356 de servidor y shared, e2e 90/92, typecheck de e2e roto.

## 7. Deuda y observaciones (sin priorizar; se ordena en `PLAN-00`)

| Id | Sev. | Qué |
|---|---|---|
| E1 | 🟠 | Sin respaldo en nube de los datos (sección 4). Es el hueco principal frente al rumbo. |
| E2 | 🟠 | Facturación solo de prueba; sin PAC elegido ni definición de dónde corre el timbrado. |
| E3 | ✅ | ✅ Resuelto en el plan 01 (`7ae9486`, `b5fefca`): eran de entorno (macOS, equipo lento), no de producto. |
| E4 | ✅ | ✅ Integrada en la rama de sesión (`e6c9057`); falta decidir su paso a `main` (el dueño evalúa la rama). |
| E5 | ✅ | ✅ Biome, commitlint, husky y CI (`ab1a3f4`, `b8366b4`, `332f3e7`). Falta activar el repositorio en GitHub Actions. |
| E6 | 🟡 | Historia de git de 3 commits muy grandes; los futuros deben ser pequeños. |
| E7 | 🟡 | Despliegue de Nodo en el local solo documentado para Windows (servicio por PowerShell). Sin empaquetado, sin actualizaciones remotas, sin Docker. |
| E8 | ✅ | ✅ Rutas portables (`d014f99`, `7ae9486`). |
| E9 | 🟡 | Los límites de plan solo se aplican si hay licencia instalada («sin licencia no hay límites»). Una instalación sin licencia es ilimitada. Decisión comercial pendiente. |
| E10 | ⚪ | Nombre de plan «INICIO» (landing) vs `gratis` (código). |
| E11 | ⚪ | JWT en `localStorage`; sin límite de intentos de PIN comprobado más allá de `attempt()` en `auth.ts` (no auditado). |
| E13 | 🟠 | **Sin HTTPS ni contexto seguro en la LAN** (verificado: no hay TLS en `app.ts`/`main.ts`). El service worker (`sw.js`) solo se registra con `isSecureContext` (`main.tsx:13`), así que sobre `http://<ip>:3003` no se registra: la app no se instala y, si la tablet recarga sin red, queda en blanco. |
| E14 | 🟠 | **Cola offline del cliente parcial** (`api.ts:172-235`): solo encola `order` y `request_bill`, no `open_table` (el servidor sí lo soporta en `/api/sync`); guarda en `localStorage` (cuota ~5 MB, menos durable que IndexedDB); el menú y las mesas no se cachean (`sw.js` nunca cachea `/api`). Una tablet que pierde el WiFi con la app abierta puede seguir pidiendo en mesas ya abiertas; si recarga, no. |
| E15 | 🟠 | **El servidor del local es punto único de falla.** Hay reinicio automático (tarea programada, 999 reintentos cada minuto) pero no hay servidor de reserva, ni restauración guiada, ni aviso a los dispositivos de «servidor caído» más allá de la reconexión del WebSocket. |
| E16 | 🟠 | **Impresión: decidido que todas serán de red (2026-10-03), así que USB no es requisito** (`PLAN-FASE1` lo prometía; no existe y no se construye). **Falta apertura de cajón** (pulso ESC/POS por la impresora), descubrimiento de impresoras en la red (escaneo del puerto 9100 y asignación de IP fija) y estado visible por impresora. **Sin evidencia de prueba con impresora física en este repo** (las pruebas usan `FakeTransport`). |
| E17 | 🟡 | **Sin descubrimiento del servidor** (mDNS `nodo.local`, QR de acceso): `PLAN-FASE1` lo prometía; hoy se teclea la IP, que debe ser fija. |
| E18 | 🟡 | **Sin registros ni observabilidad:** `Fastify({ logger: false })` (`app.ts:80`). Un fallo en un local no deja rastro. |
| E19 | 🟡 | **Sin instalador ni actualizaciones:** el despliegue es un script de PowerShell sobre el código fuente (`pnpm install` en el local). Sin versión visible, sin actualización remota, sin migración guiada. |
| E20 | 🔴 | **Credenciales por defecto en producción:** `seed` crea admin con contraseña `admin1234` si no se define `ADMIN_PASSWORD`, y meseros y caja con PIN 1111, 2222 y 3333 (`003/README.md`). El script de instalación llama al seed sin pedir nada. Una instalación real arranca con claves públicas conocidas. |
| E21 | 🟠 | **El instalador exige código fuente y herramientas de desarrollo en el equipo del local:** `install-windows-service.ps1` hace `pnpm build` y ejecuta TypeScript con `tsx`; requiere Node, pnpm, el repositorio y conexión para instalar dependencias. El registro (`server.log`) se anexa sin rotación. |
| E22 | 🔴 | **La licencia no resiste a un usuario con intención** (verificado en `license.ts` y `routes/cloud.ts`): la firma (Ed25519) es correcta, pero (1) la clave pública se guarda en la tabla `settings` del propio SQLite (`hq_public_key`) y se descarga del HQ cuya URL teclea el usuario: quien monte su HQ propio firma sus licencias; (2) sin licencia o sin clave, `getLicense` devuelve `null` = **sin límites** (E9): borrar la fila basta; (3) el código llega en claro (TypeScript con `tsx`) y se parchea con un editor; (4) no está atada al equipo, así que se copia entre locales. Aplica a todo software instalado en el cliente; ver D13. |
| E12 | ⚪ | Sin auditoría de seguridad, de rendimiento ni de uso real (ninguno de los tres se ha hecho). |

## 8. Cómo arrancarlo

Ver «Comandos» en [`../CLAUDE.md`](../CLAUDE.md).

## 9. Historial de cambios de este documento

- **2026-10-03** — Primera versión, tras la evaluación inicial del repositorio.
