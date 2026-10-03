# KYLOO · NODO

**Nodo** es un comandero (punto de venta) para restaurantes que **funciona sin Internet**: un servidor en el local es la fuente de verdad y las tablets, la caja y la cocina son navegadores (o la app de tablet) en la misma red. Este monorepo contiene el software, su servidor de nube (HQ), la app de tablet y la página de venta.

> **Si vas a trabajar aquí, lee en este orden:** este README → [`CLAUDE.md`](CLAUDE.md) (contexto, comandos y las trampas que ya nos mordieron) → [`docs/ESTADO-ACTUAL.md`](docs/ESTADO-ACTUAL.md) → el plan de la etapa en la que vayas a tocar.

## Cómo está armado

```
   Tablets · caja · cocina (navegador o app Android)          Impresoras de red (TCP 9100)
                 │  WiFi/Ethernet, sin Internet                        ▲
                 ▼                                                      │
        ┌────────────────────────────┐   copia cifrada cada 5 min   ┌───────────────┐
        │ Servidor del local         │ ───────────────────────────▶ │ Servidor de    │
        │ Node 24 + SQLite (principal)│                              │ reserva (LAN)  │
        └──────────────┬─────────────┘                              └───────────────┘
                       │ cuando hay Internet: licencia, respaldo cifrado, resúmenes
                       ▼
        ┌────────────────────────────┐
        │ HQ (nube, Railway)         │   Node + PostgreSQL + volumen de respaldos
        │ organizaciones, licencias, │   (el HQ NO puede leer los respaldos: van cifrados)
        │ respaldos                  │
        └────────────────────────────┘
```

**Regla de producto que no se negocia:** vender, enviar a cocina, imprimir y cobrar **nunca dependen de Internet**. Todo lo que necesite red (nube, licencia, respaldo, timbrado fiscal) degrada con elegancia y se pone al día al volver la conexión.

| Carpeta | Qué es |
|---|---|
| `003/apps/server` | Servidor Fastify 5 + `node:sqlite` (local) o PostgreSQL (HQ). Rutas, licencias, respaldos, impresión, reserva. |
| `003/apps/web` | Interfaz React 19 + Vite (PWA) para meseros, cocina, caja y administración; también la consola del HQ (`/hq`). |
| `003/apps/mobile` | App de tablet Android (Capacitor): lleva la interfaz dentro y habla con el servidor del local. |
| `003/apps/e2e` | Pruebas de navegador (Chrome real con puppeteer) y de accesibilidad (axe-core). |
| `003/packages/shared` | Tipos y contratos compartidos (p. ej. `API_CONTRACT`). |
| `003/packaging` | Construye el paquete instalable (Node + un solo `.mjs` + instalador de Windows). |
| `landing/` | Página de venta (Next.js) con videos renderizados desde HTML. |
| `docs/` | **Toda** la documentación persistente: planes, estado, diseño, guías de despliegue. |

## Levantar el entorno de desarrollo

### 1. Requisitos
| Herramienta | Versión | Para qué |
|---|---|---|
| **Node.js** | **≥ 24** (ver `.nvmrc`) | Servidor (`node:sqlite` viene incluido) y herramientas |
| **pnpm** | **11.21.0** | Gestor del workspace `003/`. ⚠️ El `pnpm` global suele ser otro: usa `npx -y pnpm@11.21.0 <comando>` (o `corepack`) |
| **Google Chrome** | reciente | Pruebas e2e (`CHROME_PATH` si no está en la ruta de siempre) |
| Docker | opcional | Probar el servidor contra PostgreSQL (como el HQ) |
| JDK 17–21 + Android SDK | opcional | Solo para `003/apps/mobile` (⚠️ Gradle no soporta JDK 25) |
| `makensis` | opcional | Solo para generar el `.exe` instalador de Windows |

### 2. Primera vez
```bash
git clone https://github.com/joseman11/KYLOO-NODO.git && cd KYLOO-NODO
npm install                     # raíz: Biome (formato/lint), commitlint y los hooks de husky
cd 003
alias p='npx -y pnpm@11.21.0'   # o instala pnpm 11.21.0
p install
p --filter @003/web build       # la interfaz compilada (el servidor la sirve desde aquí)
```

### 3. Arrancar
```bash
# Opción A — datos de demostración (marisquería de ejemplo), sin tocar nada tuyo:
export DB_FILE=/tmp/nodo-demo/demo.sqlite PHOTOS_DIR=/tmp/nodo-demo/photos
p --filter @003/server seed:demo
PORT=3005 p --filter @003/server start          # http://localhost:3005

# Opción B — instalación vacía (lo que ve un cliente nuevo): asistente de primer arranque
p --filter @003/server start                    # http://localhost:3003 (crea al administrador; solo desde ese equipo)
```
Usuarios de la demo (**solo desarrollo**): administrador `admin` / `admin1234`; PIN de meseros `1111` (Juan), `2222`, `4444`, `5555`; caja `3333`; gerente `6666`; cocina `7777`; barra `8888`. Una instalación real **no** trae usuarios ni claves de fábrica.

**Con recarga en caliente de la interfaz:** deja el servidor en el puerto 3003 y, en otra terminal, `p --filter @003/web dev` (Vite en `http://localhost:5173`, con proxy a `/api` y `/ws`). Para el servidor con recarga: `p --filter @003/server dev`.

Puertos por convención: servidor del local `3003`, HQ `3004`, demos `3005`/`3006`, landing `3000`.

### 4. Probar
```bash
p typecheck                                            # los cuatro paquetes
p --filter @003/shared --filter @003/server test       # unitarias y de API en SQLite (~15 s)
p --filter @003/web build && p --filter @003/e2e test  # navegador real, ~7 min en serie; compilar la web antes
p --filter @003/packaging test                         # el modo de licencia de producción queda fijo

# El mismo servidor contra PostgreSQL (como el HQ de producción):
docker run -d --name nodo-pg -e POSTGRES_PASSWORD=nodo -e POSTGRES_DB=nodo_test -p 5433:5432 postgres:16-alpine
NODO_PG_URL=postgres://postgres:nodo@127.0.0.1:5433/nodo_test p --filter @003/server test
```
En el e2e, si Chrome no está en su ruta habitual: `CHROME_PATH="/ruta/a/chrome"`. **Nunca se duerme un tiempo fijo en una prueba de navegador**: se espera a una condición.

### 5. Reglas de contribución
- **Rama por etapa** (`feature/<nombre>`, `fix/<nombre>`); `main` es la base y no recibe commits directos.
- **Commits** en español con [Conventional Commits](https://www.conventionalcommits.org/) (`feat(hq): …`, `fix(web): …`, `docs: …`); asunto ≤ 100 caracteres. Los hooks lo validan.
- **Formato y lint:** Biome (`npm run lint`, `npm run lint:fix` desde la raíz). En CI solo bloquean los errores; los avisos son deuda anotada. ⚠️ **Nunca `biome … --unsafe` en masa**: cambia comportamiento (ver trampa 28 de `CLAUDE.md`).
- **Toda decisión o aprendizaje persistente va en `docs/`**, no en el chat; cada etapa tiene su `PLAN-NN` con casillas, registro y pendientes.
- **Pantallas nuevas:** respeta [`docs/DESIGN.md`](docs/DESIGN.md) (estados con `StatusChip`, ayuda con `Hint`, borrados con `DeleteButton`, sin `prompt()`/`confirm()`); la prueba de accesibilidad debe seguir en cero hallazgos serios.
- **CI** (`.github/workflows`): `ci.yml` (lint, commits, servidor, build) en cada PR; `e2e.yml` aparte porque es lenta.

## Cómo funciona en despliegue

Hay **cuatro cosas que se despliegan**, cada una por su camino. Detalle de cada una en su guía.

### A. El servidor del local (lo que compra el cliente)
- Se entrega como **paquete instalable** sin herramientas de desarrollo: `Nodo-Setup-<versión>.exe` (Windows). Instala Node oficial verificado, el servidor empaquetado en un solo `server.mjs` y un **servicio de Windows** que arranca con el equipo y se reinicia solo. Los **datos** (base, fotos, respaldos, registros) viven en `%ProgramData%\Nodo`, fuera del programa: actualizar o desinstalar no los toca.
- Construirlo (en desarrollo):
  ```bash
  p --filter @003/packaging build -- --license open                                   # paquete -dev, sin límites: NO se distribuye
  p --filter @003/packaging build -- --platform win32 --arch x64 \
      --license-public-key <license-public.pem> --hq-url <url-del-HQ>                  # producción: la clave pública queda incrustada
  p --filter @003/packaging smoke                                                     # prueba de humo del paquete -dev
  ```
- **Licencia** (suscripción anual): Ed25519, atada al equipo; se activa con un **código de un solo uso** que emite el HQ. Vencida o sin licencia = plan gratuito (**nunca se detiene la venta**).
- **Respaldo:** diario local (14 copias) + copia **cifrada de extremo a extremo** al HQ cuando hay red. La clave de recuperación no sale del cliente (si se pierden clave y equipo, no hay recuperación). Restaurar en una PC nueva: `server.mjs restore --hq-url … --code … --key …`.
- **Servidor de reserva:** una segunda PC copia al principal y se promueve con un botón si este se cae.
- Guías: [`docs/deploy/INSTALACION.md`](docs/deploy/INSTALACION.md) · [`LICENCIAS.md`](docs/deploy/LICENCIAS.md) · [`RESPALDOS.md`](docs/deploy/RESPALDOS.md) · [`RESERVA.md`](docs/deploy/RESERVA.md) · [`RED-LOCAL.md`](docs/deploy/RED-LOCAL.md).

### B. El HQ (la nube de Nodo) — Railway
- Mismo servidor con `ROLE=hq`, sobre **PostgreSQL** (`DATABASE_URL`) y un **volumen en `/data`** para los respaldos cifrados. Construye con `003/Dockerfile` (`Root Directory = /003`), healthcheck `/api/health`.
- Variables obligatorias: `DATABASE_URL`, `HQ_SIGNING_KEY` (la **clave privada** de licencias; sin ella el HQ no arranca), `HQ_ADMIN_TOKEN`, `HQ_KEY_ID`. Todas son **secretos del entorno**: no van al repositorio.
- Consola web en `/hq`: organizaciones, sucursales, códigos de activación, uso de respaldos (descargar/borrar).
- Desplegar una versión nueva: `npx -y @railway/cli up --service nodo-hq` (CLI autenticada). Guía y IDs: [`docs/deploy/HQ-RAILWAY.md`](docs/deploy/HQ-RAILWAY.md). ⚠️ `railway.json` está marcado obsoleto por Railway (funciona hasta 2026-12-01); migrar con `railway config plan` **antes** de aplicar.

### C. La app de tablet (Android)
- Capacitor: la interfaz va **dentro** de la app y se conecta al servidor del local (dirección escrita o QR de *Configuración → Conectar*). Como lleva su copia de la interfaz, si cambia la API de forma incompatible se sube `API_CONTRACT`.
- APK de entrega firmado: `source ~/.nodo-keys/android/signing.env` y `node apps/mobile/scripts/build-apk.mjs --release` (con `JAVA_HOME` en un JDK 17–21 y `ANDROID_HOME`). **Hay que reconstruirlo cada vez que cambia la interfaz.** Guía: [`docs/deploy/APP-TABLET.md`](docs/deploy/APP-TABLET.md).

### D. La landing — Railway
- Servicio aparte con `Root Directory = /landing` (Nixpacks, `npm run build` / `npm run start`, healthcheck en `/`). Las variables `NEXT_PUBLIC_*` se leen **al compilar**: cambiar una exige redesplegar. Variables: `NEXT_PUBLIC_WHATSAPP` o `NEXT_PUBLIC_CONTACT_EMAIL` y `NEXT_PUBLIC_SITE_URL`. Detalle en [`landing/README.md`](landing/README.md).

### Antes de entregar una versión (lista corta)
1. `p typecheck`, servidor en SQLite **y** PostgreSQL, `packaging test` y e2e completas en verde.
2. `pnpm audit --prod` (003) y `npm audit` (landing) en cero.
3. Subir `version` y construir el paquete de producción + (si cambió la interfaz) el APK firmado.
4. Redesplegar el HQ si cambió el servidor o el contrato; comprobar `/api/health` (`engine: pg`, `contract`).
5. Anotar en el `PLAN-NN` que corresponda (registro y pendientes).

## Secretos y claves (no entran al repositorio)
| Qué | Dónde vive | Si se pierde |
|---|---|---|
| Clave **privada** de licencias | Railway (`HQ_SIGNING_KEY`) + copia fuera de línea (`~/.nodo-keys/`) | No se pueden emitir ni renovar licencias; los locales instalados solo aceptan las firmadas con ella |
| Llave de firma del **APK** | `~/.nodo-keys/android/` + copia fuera de línea | Las tablets de los clientes habría que reinstalarlas desde cero (Android solo actualiza con la misma firma) |
| Clave de recuperación de respaldos | Solo el cliente | Sin ella y sin el equipo, no hay recuperación (por diseño) |
| `HQ_ADMIN_TOKEN` | Railway | Se regenera |

## Documentación
Todo lo persistente vive en [`docs/`](docs/README.md): [`ESTADO-ACTUAL`](docs/ESTADO-ACTUAL.md) (qué existe y qué está roto), los planes `PLAN-00` … `PLAN-08` (decisiones, registro, pendientes), [`DESIGN`](docs/DESIGN.md) (sistema visual v2), [`AUDITORIA-SEGURIDAD`](docs/AUDITORIA-SEGURIDAD-2026-10-03.md) y las guías de [`docs/deploy/`](docs/deploy). Contexto de trabajo y trampas: [`CLAUDE.md`](CLAUDE.md); mapa de carpetas: [`STRUCTURE.md`](STRUCTURE.md); detalle del servidor y de las funciones: [`003/README.md`](003/README.md).
