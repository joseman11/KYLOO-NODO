# Plan 02 — Empaquetado, instalación y primer arranque

> **Etapa abierta** (2026-10-03, rama `feature/sesion-autonoma-2026-10-03`). Continúa a [`PLAN-01`](PLAN-01-LINEA-BASE-Y-CALIDAD.md). Resuelve las decisiones D5 (cierre) y D7 de [`PLAN-00`](PLAN-00-ESTRUCTURA-DE-TRABAJO.md) y los hallazgos E18, E19, E20 y E21 de [`ESTADO-ACTUAL`](ESTADO-ACTUAL.md).
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

- [ ] **F2.1 — `node:sqlite` en lugar de `better-sqlite3`.** Se comprueba con las 350 pruebas y la de PostgreSQL.
- [ ] **F2.2 — Configuración central y carpeta de datos** (`config.ts`), versión visible en `/api/health`.
- [ ] **F2.3 — Registros con rotación, apagado ordenado y errores no capturados.**
- [ ] **F2.4 — Asistente de primer arranque** (servidor, pantalla y pruebas, también e2e).
- [ ] **F2.5 — Copia antes de migrar.**
- [ ] **F2.6 — Construcción del paquete** (`packaging/`): bundle, ensamblado, prueba de humo del paquete en esta máquina.
- [ ] **F2.7 — Artefactos de Windows** (WinSW, scripts, NSIS si es posible) y `docs/deploy/INSTALACION.md`.
- [ ] **F2.8 — Cierre.**

## 5. Decidido con el dueño

`PLAN-00` §5: Node se queda y se empaca el servidor; instalan los primeros locales el dueño, con proceso pulido; impresoras por red; licencia atada al equipo (la protección va en el plan 03).

## 6. Registro

*(se rellena al cerrar cada fase)*
