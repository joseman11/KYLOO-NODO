# Plan 02 — Empaquetado, instalación y primer arranque

> **Etapa cerrada** (2026-10-03, rama `feature/sesion-autonoma-2026-10-03`). Continúa a [`PLAN-01`](PLAN-01-LINEA-BASE-Y-CALIDAD.md). Resuelve las decisiones D5 (cierre) y D7 de [`PLAN-00`](PLAN-00-ESTRUCTURA-DE-TRABAJO.md) y los hallazgos E18, E19, E20 y E21 de [`ESTADO-ACTUAL`](ESTADO-ACTUAL.md).
>
> 🤖 Sesión autónoma (el dueño duerme): lo abierto lo decide la sesión y queda en el Registro.
>
> **Se sigue estrictamente.** Una sesión que retome esto lo lee entero y marca la casilla de cada fase, con su commit, al cerrarla.
>
> ### Cómo empieza la sesión que lo retome
> 1. Leer este documento, `PLAN-00` §2 y `ESTADO-ACTUAL.md`.
> 2. `git status`, `git log --oneline -20`, rama de la sesión.
> 3. Reverificar: `cd 003 && npx -y pnpm@11.21.0 --filter @003/server test` (350 en verde).

## 0. El encargo, literal y resumido

> «Vale, permanecemos en Node empacando el servidor.» (2026-10-03)

> «El tema de esa instalación… ¿es seguro a nivel de que no nos crackeen la licencia? Como proveedores del servicio creo que se necesita una forma más eficiente del proceso.» (2026-10-03)

> «Yo instalaría en los primeros locales, pero aun así lo quiero pulido.» (2026-10-03)

> «Impresoras por red / conectadas a ethernet.» (2026-10-03)

Resumen: que instalar Nodo en el local sea un proceso corto, repetible y sin herramientas de desarrollo; que un primer arranque no deje claves públicas; que una actualización fallida nunca pierda datos; y que quede un rastro (registros) de lo que pase en un local. La **protección de la licencia** es el plan 03.

## 1. Lo que hay hoy (mapa verificado, 2026-10-03)

- La instalación exige Node, pnpm, el repositorio entero y herramientas de compilación en la PC del local (`003/scripts/install-windows-service.ps1`): E21.
- El script siembra una base con `admin1234` y PIN 1111/2222/3333 (E20) y registra una tarea programada que ejecuta TypeScript con `tsx`.
- `Fastify({ logger: false })`: sin registros (E18). El `server.log` del script solo recoge la salida estándar y no rota.
- `main.ts` toma tres variables sueltas (`DB_FILE`, `BACKUP_DIR`, `PHOTOS_DIR`) sin una carpeta de datos única.
- Un módulo nativo (`better-sqlite3`) obligaba a compilar o a descargar binarios por plataforma y por versión de Node.
- Node 24 trae `node:sqlite` (SQLite 3.53.4, con `backup`).

## 2. Decisiones

**D2.1 — El servidor usa `node:sqlite` y se retira `better-sqlite3`.** Quita el único módulo nativo: el paquete se arma con el `node` oficial de cada plataforma más JavaScript, sin compilar nada y sin descuadrarse al actualizar Node. Es «experimental» en Node 24, pero **Nodo lleva su propio Node fijado** (no el del sistema), así que la API solo cambia cuando nosotros subimos de versión y las 350 pruebas lo detectan. Medido: la suite del servidor da lo mismo (350 en verde, 12.6 s frente a 11.4–13 s). Descartado: mantener `better-sqlite3` y descargar un binario por plataforma (más piezas que pueden fallar en un local).

**D2.2 — Una carpeta de datos única (`NODO_DATA_DIR`)** con base, fotos, respaldos y registros; las variables sueltas (`DB_FILE`, etc.) siguen mandando si se definen. Por defecto: `C:\ProgramData\Nodo` en Windows, `~/Library/Application Support/Nodo` en macOS, `/var/lib/nodo` en Linux. **Los datos nunca viven junto al programa**: actualizar o desinstalar no los toca.

**D2.3 — Primer arranque con asistente, sin datos sembrados.** El servidor arranca con la base vacía; mientras no exista ningún usuario, la app muestra un asistente (nombre del local, administrador, contraseña) y `POST /api/setup` solo funciona en ese estado. `seed` y `seed:demo` quedan para desarrollo y demos; el instalador no los llama. Elimina E20. Descartado: sembrar y exigir cambiar la contraseña (el hueco existe hasta que alguien lo cambia).

**D2.4 — Registros a archivo con rotación, sin secretos.** Un registro de la aplicación (arranque, apagado, errores, 5xx, respaldos, migraciones), con rotación por tamaño; los encabezados y la URL del WebSocket (lleva el JWT en `?token=`) se redactan. No se registra cada petición.

**D2.5 — Copia automática antes de migrar.** Si al arrancar hay migraciones pendientes sobre una base con datos, se copia la base a `backups/pre-migracion-<id>.sqlite` antes de aplicarlas. Una migración que falla deja el programa viejo y la base intacta.

**D2.6 — Paquete = Node oficial + un solo archivo JavaScript + la app web.** Se genera con `esbuild` (un `server.mjs`), sin SEA de Node (menos límites, y se puede actualizar el Node empaquetado sin recompilar). El servicio de Windows lo ejecuta **WinSW** (ejecutable único y de código abierto que convierte cualquier programa en servicio real, con reinicio y rotación de su propio registro). El instalador de Windows es un `.exe` generado con NSIS si se puede en este equipo; si no, se entrega el paquete en ZIP con `install.ps1` y `uninstall.ps1`, y se dice que el `.exe` queda por generar. **No se ha podido ejecutar nada en Windows**: se prueba el paquete en macOS y se revisan los scripts a mano, y eso queda anotado como «sin probar en Windows».

## 3. Invariantes

- **I2.1.** Instalar, actualizar o desinstalar nunca borra ni sobrescribe la carpeta de datos.
- **I2.2.** Ninguna instalación arranca con credenciales conocidas.
- **I2.3.** Una actualización que falla deja el sistema anterior funcionando con sus datos.
- **I2.4.** El servidor corre sin Internet ni herramientas de desarrollo en el equipo.
- **I2.5.** Las pruebas de servidor y e2e siguen en verde (I5 del plan 00).

## 4. Orden

- [x] **F2.1 — `node:sqlite` en lugar de `better-sqlite3`.** `9bccb89`.
- [x] **F2.2 — Configuración central y carpeta de datos** (`config.ts`), versión visible en `/api/health`. `0b9aafe`.
- [x] **F2.3 — Registros con rotación, apagado ordenado y errores no capturados.** `0b9aafe`.
- [x] **F2.4 — Asistente de primer arranque** (servidor, pantalla y pruebas, también e2e). `0cde153`.
- [x] **F2.5 — Copia antes de migrar.** `0b9aafe`.
- [x] **F2.6 — Construcción del paquete** (`packaging/`): bundle, ensamblado, prueba de humo del paquete en esta máquina.
- [x] **F2.7 — Artefactos de Windows** (WinSW, scripts, NSIS) y `docs/deploy/INSTALACION.md`. **Sin probar en Windows.**
- [x] **F2.8 — Cierre.**

## 5. Decidido con el dueño

`PLAN-00` §5: Node se queda y se empaca el servidor; instalan los primeros locales el dueño, con proceso pulido; impresoras por red; licencia atada al equipo (la protección va en el plan 03).

## 6. Registro

- **2026-10-03 (noche, sesión autónoma)** — Cierre del plan.
  - **Hecho:** F2.1 a F2.8.
  - **Medido:**
    - Servidor empaquetado en macOS: **94 MB de RAM** en reposo; `node` 110 MB + `server.mjs` 2.8 MB + app web; paquete de **132 MB en disco y 39 MB comprimido**. Windows: 118 MB en disco, **ZIP de 42 MB y `Nodo-Setup-0.1.0.exe` de 30 MB**.
    - Suite de servidor con `node:sqlite`: 376 en SQLite y 376 en PostgreSQL (duración igual que con `better-sqlite3`: 12–13 s). e2e: **97/97** (con las 5 nuevas del asistente).
    - Prueba de humo del paquete (`smoke.mjs`): salud y versión, instalación nueva, alta, acceso, **apagado con SIGTERM (código 0, registrado)** y reinicio sin perder datos.
    - Scripts de Windows: sintaxis verificada con el analizador de PowerShell 7.4 (descargado en el scratchpad) y sustitución del puerto en el XML probada.
  - **Salió por el camino:**
    - Vitest (Vite) reescribe `node:sqlite` a «sqlite»: el adaptador carga el módulo con `process.getBuiltinModule` (`CLAUDE.md`, trampa 12).
    - El `define` de esbuild no veía `env.NODO_VERSION`: la versión empaquetada salía «dev»; ahora se lee `process.env.NODO_VERSION` literal al cargar el módulo.
    - Fastify 5.12 deprecó `disableRequestLogging` (hay que usar `logController`) y con esa opción **tampoco registra los errores 5xx**: se registran a mano en el manejador de errores.
    - 🔴 **Riesgo hallado y corregido:** el respaldo «al arrancar» + retención de 14 hacía que un servicio que se reinicia en bucle **desplazara los respaldos buenos con copias idénticas**. Ahora solo respalda al arrancar si el último automático tiene más de 12 h y las copias previas a migrar tienen su propia retención (5).
    - La `.exe` de WinSW 2.12 pesa 18 MB (autocontenida, no exige .NET): se fijó su SHA-256.
    - No existen imágenes arm64 de PowerShell en Docker; se usó el tarball de macOS.
  - **Decisiones tomadas por la sesión:** D2.1 a D2.6 del plan (con las recomendaciones del plan 00); además, se **eliminó `003/scripts/install-windows-service.ps1`** (sembraba claves de fábrica y exigía código fuente) y la acción de firewall limita a la red local en cualquier perfil (Windows suele marcar la red de un local como «Pública»).
  - **Encontrado de paso, anterior a esta etapa y sin arreglar aquí:**
    - Un error 500 devuelve `err.message` al cliente (puede filtrar texto interno). Revisar en el plan de seguridad.
    - `GET /api/auth/users` es público (nombre, rol y foto de cada usuario) por diseño del login por PIN; el bloqueo por intentos es por usuario, no por IP.
  - **Estado de la máquina:** `makensis` instalado con Homebrew (`/opt/homebrew/bin/makensis`) para generar el `.exe`; PowerShell portable en el scratchpad; contenedor `nodo-pg` en marcha.

### Cómo retomarlo
Plan 02 cerrado. Seguir con `PLAN-03` (licencias y activación).

### Pendiente
- 🔴 **Instalación real en una PC con Windows** (instalador, servicio, reinicio tras caída, firewall, actualización sobre una instalación previa).
- 🟠 Firmar el instalador (certificado de firma de código).
- 🟡 Apagado ordenado en Windows (WinSW termina el proceso; SQLite lo tolera).
