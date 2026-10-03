# Reporte de la sesión autónoma — 2026-10-03

> Escrito para quien retoma por la mañana. Todo el trabajo está en la rama **`feature/fundacion`** (36 commits sobre `main`, 229 archivos, +36 878 −6 355 líneas). **No se hizo push, no se desplegó nada y no se tocó ningún secreto.** Cada plan tiene su propio registro con el detalle; esto es el resumen y lo que hay que decidir.

## Cómo revisarlo

```bash
git log --oneline main..feature/fundacion     # 36 commits pequeños y separables
git diff --stat main..feature/fundacion
cd 003 && npx -y pnpm@11.21.0 install
npx -y pnpm@11.21.0 typecheck
npx -y pnpm@11.21.0 --filter @003/shared --filter @003/server test      # 471 en SQLite
docker run -d --name nodo-pg -e POSTGRES_PASSWORD=nodo -e POSTGRES_DB=nodo_test -p 5433:5432 postgres:16-alpine
NODO_PG_URL=postgres://postgres:nodo@127.0.0.1:5433/nodo_test npx -y pnpm@11.21.0 --filter @003/server test   # 472
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npx -y pnpm@11.21.0 --filter @003/e2e test   # 111 e2e
```

Resultado final de la sesión: **typecheck limpio; 471 pruebas de servidor en SQLite y 472 en PostgreSQL; 111 e2e; 4 pruebas del empaquetado; `pnpm audit` y `npm audit` en cero.**

## Qué se hizo (por plan)

| Plan | Resultado | Documento |
|---|---|---|
| 00 | Repo listo para el método: `CLAUDE.md`, `STRUCTURE.md`, `docs/`, decisiones D1–D5 y D13 cerradas contigo | `PLAN-00` |
| 01 | `nube-web` integrada; los 2 rojos de e2e eran **de entorno** (macOS, equipo lento), no de producto; Biome, commitlint, husky, CI | `PLAN-01` |
| 02 | Servidor **sin módulo nativo** (`node:sqlite`); paquete instalable (Node oficial + un archivo JS); instalador `.exe` de Windows; asistente de primer arranque **sin claves de fábrica**; registros con rotación; copia automática antes de migrar | `PLAN-02`, `deploy/INSTALACION.md` |
| 03 | Licencia **atada al equipo**, clave pública incrustada, activación por código de un solo uso, restringido-nunca-bloqueado | `PLAN-03`, `deploy/LICENCIAS.md` |
| 04 | **Respaldo cifrado de extremo a extremo** en el HQ, restauración en una PC nueva, HQ en PostgreSQL con Docker y listo para Railway | `PLAN-04`, `deploy/RESPALDOS.md`, `deploy/HQ-RAILWAY.md` |
| 05 | Cajón de dinero, búsqueda de impresoras, `nodo.local` + QR, **mesa y comanda sin conexión** | `PLAN-05`, `deploy/RED-LOCAL.md` |
| — | **Auditoría de seguridad**: 5 hallazgos cerrados (incluido `fast-jwt` con fallos críticos) | `AUDITORIA-SEGURIDAD-2026-10-03.md` |
| — | Consola del HQ: códigos de activación y estado de equipos y respaldos | `deploy/HQ-RAILWAY.md` |

## Decisiones que tomé yo (con las recomendaciones de los planes) y que puedes revertir

1. **`nube-web` se integra** (merge `--no-ff`, revertible de una vez). Convierte todo el acceso a datos en asíncrono.
2. **SQLite local = `node:sqlite`** (se retira `better-sqlite3`). Motivo: un solo paquete sin compilar, construible para Windows desde macOS. Riesgo: API «experimental» de Node, controlado porque Nodo lleva su propio Node fijado y las 471 pruebas lo vigilan.
3. **Formateo masivo con Biome** en un solo commit `style` (+25 mil −6 mil líneas, solo formato).
4. **Se eliminó `003/scripts/install-windows-service.ps1`** (sembraba `admin1234` y exigía código fuente).
5. **El paquete de producción exige elegir licencia al construirse**; `--license open` produce un paquete `-dev` sin límites que no se distribuye.
6. **La configuración inicial solo se hace desde el propio equipo** (`localhost`), no desde la red.
7. **La clave de recuperación de los respaldos no la conoce Nodo**: si se pierden la PC y la clave, no hay recuperación.
8. **Límite de 120 accesos por IP cada 5 minutos** y cabeceras de seguridad con política de contenido.

## Lo que necesito de ti (no lo podía decidir ni hacer sola)

- 🔴 **Generar la clave de licencias de producción** (`keygen`) y ponerla como `HQ_SIGNING_KEY` en Railway. **No generé ninguna.**
- 🔴 **Probar con equipo real:** una impresora térmica de red, un cajón y una tablet barata; y el **instalador en una PC con Windows** (hoy solo probé el paquete de macOS y la sintaxis de los scripts de Windows).
- 🔴 **Desplegar el HQ en Railway** (guía en `deploy/HQ-RAILWAY.md`) y probar el recorrido contra esa URL.
- 🟠 **D11:** HTTPS local o app envoltorio para que una tablet pueda *recargar* sin red (hoy solo funciona con la página ya abierta).
- 🟠 **Firma de código** del instalador (certificado) para evitar la advertencia de Windows.
- 🟡 Modelo comercial (suscripción o pago único), PIN de 6 dígitos para gerentes, impresora del primer local, prueba de penetración externa antes del primer cliente.

## Qué probar tú en pantalla

- **`http://localhost:3005`** (demo; `admin`/`admin1234`, PIN Juan `1111`, Caja `3333`) y **`http://localhost:3006`** (instalación vacía: asistente de primer arranque, solo desde esa Mac). Si ya los apagaste: `cd 003/apps/server`, `NODO_DATA_DIR=/tmp/x PORT=3006 npx -y pnpm@11.21.0 start`.
- *Configuración → Conectar* (QR), *Impresoras* (buscar, cajón, probar), *Nube y plan* (activación, respaldo, clave de recuperación), *Caja → Abrir cajón*, y abrir una mesa con la red cortada (apaga el WiFi del dispositivo, no el servidor).

## Cosas que dejé instaladas en tu Mac

- **`makensis`** (Homebrew) para generar el `.exe`: `brew uninstall makensis`.
- Contenedor Docker **`nodo-pg`** (PostgreSQL de pruebas): `docker rm -f nodo-pg`.
- Un PowerShell portable y las claves de prueba quedaron en el directorio temporal de la sesión (no en el repo).

## Hallazgos de paso que conviene conocer

- La suite en PostgreSQL **filtraba esquemas** (había 1022 acumulados y fallaba en bloque): corregido.
- `fast-jwt` tenía **avisos críticos de evasión de autenticación**: actualizado.
- Las e2e son sensibles a la carga de la máquina (Chrome sin cabeza a ~8 cuadros/s): dos pruebas fallaron una vez con la máquina saturada y pasaron al repetirlas solas.
- Las **tablets baratas** correrán a pocos cuadros por segundo: la app ahora no pinta listas sin medirlas (parpadeo corregido) y habrá que medir en hardware real.
