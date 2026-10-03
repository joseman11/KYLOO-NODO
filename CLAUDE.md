# KYLOO-NODO — Contexto de trabajo

**Nodo** es un comandero (POS de restaurante) que funciona **sin internet**: un servidor en el local es la fuente de verdad y tablets, cocina y caja son navegadores en la misma red. Este repo contiene el software (`003/`) y su página de venta (`landing/`). Se venderá en dos modalidades, local y nube, y la operación del local **nunca puede depender de internet**.

**Nuestro trabajo es todo el repositorio** (servidor, app web, landing, pruebas, documentación y despliegue). No hay equipo ajeno: no existe un backend de otro equipo que consumir.

> [!IMPORTANT]
> El método de trabajo general vive en la skill `kyle-from-kyloo` (`/Users/ander/Software/Tools/KYLOO-TOOLS/skills/kyle-from-kyloo/SKILL.md`). **Este `CLAUDE.md` manda en lo específico del repo** (comandos, trampas, rutas); la skill manda en el método. Si chocan, gana el repo y la diferencia se anota aquí.

## Documentos de referencia

| Documento | Estado | Cuándo consultarlo |
|---|---|---|
| [`docs/PLAN-02-EMPAQUETADO-E-INSTALACION.md`](docs/PLAN-02-EMPAQUETADO-E-INSTALACION.md) | **Etapa abierta** (2026-10-03), sesión autónoma | Antes de tocar el arranque del servidor, la base local o el instalador. |
| [`docs/deploy/INSTALACION.md`](docs/deploy/INSTALACION.md) | Vivo | Cómo se instala, actualiza y desinstala Nodo; cómo construir el paquete. |
| [`docs/PLAN-05-IMPRESION-Y-RED-LOCAL.md`](docs/PLAN-05-IMPRESION-Y-RED-LOCAL.md) · [`docs/deploy/RED-LOCAL.md`](docs/deploy/RED-LOCAL.md) | **Cerrado** (2026-10-03) | Antes de tocar impresión, cajón, el cliente sin conexión o cómo se conectan las tablets. |
| [`docs/PLAN-04-RESPALDO-EN-NUBE.md`](docs/PLAN-04-RESPALDO-EN-NUBE.md) · [`docs/deploy/RESPALDOS.md`](docs/deploy/RESPALDOS.md) · [`docs/deploy/HQ-RAILWAY.md`](docs/deploy/HQ-RAILWAY.md) | **Cerrado** (2026-10-03) | Antes de tocar respaldos, restauración o el despliegue del HQ. |
| [`docs/PLAN-03-LICENCIAS-Y-ACTIVACION.md`](docs/PLAN-03-LICENCIAS-Y-ACTIVACION.md) · [`docs/deploy/LICENCIAS.md`](docs/deploy/LICENCIAS.md) | **Etapa abierta** (2026-10-03) | Antes de tocar licencias, activación o el HQ. |
| [`docs/PLAN-01-LINEA-BASE-Y-CALIDAD.md`](docs/PLAN-01-LINEA-BASE-Y-CALIDAD.md) | **Cerrado** (2026-10-03) | Para saber por qué `nube-web` está integrada y cómo se diagnosticaron los rojos de e2e. |
| [`docs/PLAN-00-ESTRUCTURA-DE-TRABAJO.md`](docs/PLAN-00-ESTRUCTURA-DE-TRABAJO.md) | **Etapa abierta** (2026-10-03), en conversación con el dueño | **Antes de hacer nada.** Es el plan vivo: léelo entero. No se escribe código de producto hasta que sus decisiones estén cerradas. |
| [`docs/ESTADO-ACTUAL.md`](docs/ESTADO-ACTUAL.md) | Vivo | Antes de proponer algo: qué existe, qué mide, qué está roto, qué deuda hay. |
| [`STRUCTURE.md`](STRUCTURE.md) | Vivo | **Antes de crear un archivo nuevo.** |
| [`docs/README.md`](docs/README.md) | Vivo | Índice de `docs/` y reglas de uso. |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Vigente (sistema visual de Nodo) | Antes de tocar cualquier pantalla de la app. |
| [`docs/DESIGN-reference-brex.md`](docs/DESIGN-reference-brex.md) | Referencia externa | Solo para entender de dónde viene `DESIGN.md`. No es fuente de verdad. |
| [`docs/INVESTIGACION-COMANDEROS.md`](docs/INVESTIGACION-COMANDEROS.md) | Investigación (2026-10-01) | Antes de decidir una función nueva de producto o de pantalla. |
| [`docs/PLAN-FASE1.md`](docs/PLAN-FASE1.md) · [`PLAN-FASE2.md`](docs/PLAN-FASE2.md) · [`PLAN-FASE3.md`](docs/PLAN-FASE3.md) | **Cerrados** (históricos, anteriores al método) | Para saber por qué se decidió algo. No son fuente de verdad del estado: gana `ESTADO-ACTUAL.md`. |
| `003/README.md`, `landing/README.md` | Vivos | Arranque y operación de cada pieza. |

## Reglas

- **Idioma:** conversación, comentarios, documentos y commits en español; identificadores y nombres de fichero en inglés (los planes y la documentación van en `docs/` con nombre en mayúsculas, como manda la skill). Los comentarios existentes explican el porqué: **no se traducen ni se recortan**.
- **Voz:** Rocky en el terminal; español normal en commits, PR y documentos.
- **Toda documentación persistente va en `docs/`**, versionada. Lo que se decide o se aprende no se queda en la conversación.
- **Offline primero (invariante de producto):** vender, enviar a cocina, imprimir y cobrar jamás dependen de internet. Todo lo que necesite red (nube, sincronización, timbrado fiscal) debe degradar con elegancia y ponerse al día al volver la conexión.
- **Sin migraciones destructivas** sin decirlo antes; copia de la base antes de migrar.
- **Fallo mudo = enemigo.** Cada cambio responde «¿cómo me enteraría si fallara en silencio?» (prueba, comprobación al arrancar o trampa escrita).
- **Lo añadido a un catálogo se aplica en el mismo commit** (permisos, límites de plan, funciones por plan).
- **Visual:** tokens de `docs/DESIGN.md`, nunca colores a pelo.

## Trampas que ya nos han mordido

1. ⚠️ **`pnpm` global del equipo es 9.0.0 y el proyecto exige 11.21.0** (`003/package.json`, `packageManager`). `corepack` no está en el PATH. Atajo que funciona: `npx -y pnpm@11.21.0 <comando>`. No da error de versión: simplemente instala distinto.
2. ✅ **Las e2e buscaban Chrome solo en rutas de Windows/Linux.** Arreglado (2026-10-03, `7ae9486`): el arnés prueba también la ruta de macOS; `CHROME_PATH` sigue mandando.
3. ✅ **`pnpm typecheck` fallaba en `apps/e2e`** (`TS2488` por falta de `DOM.Iterable`, `TS2307` porque `fastify` no era dependencia declarada). Arreglado en `7ae9486`.
4. ✅ **Dos e2e «rojas» en `main`: eran de entorno, no de producto** (diagnosticado 2026-10-03). (a) «cobra en efectivo…»: `Control+A` en macOS solo mueve el cursor y el texto tecleado se anexaba (`1035.002000`), así que no había cambio; se usa `selectAll()` del arnés, que llama a `.select()` del campo. (b) «la lista muestra…»: Chrome sin cabeza en macOS corre a ~8 cuadros por segundo; con la pantalla sin medir, el paginador calculaba una fila por página y la prueba miraba demasiado pronto. Arreglos: `fit.tsx` no pinta la lista hasta medir el contenedor y el arnés espera con `settle()`. **Regla: en una prueba de navegador nunca se duerme un tiempo fijo; se espera a una condición o a que la pantalla se estabilice.**
5. ⚠️ **`npm install` en `landing/` puede reescribir `package-lock.json`** (npm 11 frente al que lo generó). No es un cambio real: `git checkout landing/package-lock.json` antes de commitear.
6. ✅ **`landing/video-src/*.mjs` tenía rutas absolutas de Windows.** Ahora salen de `video-src/paths.mjs` (`CHROME_PATH`, `NODO_APP_DIST`, `NODO_LANDING_PHOTOS`).
7. ⚠️ **`landing/` se despliega aparte** (Railway, Root Directory `/landing`); la landing se construye con `NEXT_PUBLIC_*` leídas **al compilar**: cambiar una variable exige redesplegar.
8. ✅ **Cada archivo de e2e levanta su propio servidor con base `:memory:` y la demo de mariscos** (`harness.ts`): no ensucian estado entre archivos ni tocan `data/`. Se corren en serie (`fileParallelism: false`). No cambiarlo.
9. ⚠️ **El formateador de Biome no es idempotente a la primera** en cadenas de métodos (`reply.code().send()`): tras formatear en masa, repetir `biome format --write` hasta que diga «No fixes applied». El hook `pre-commit` lo detecta.
10. ⚠️ **Los commits pasan por commitlint** (`.husky/commit-msg`): el tipo debe ser uno de la skill. Un merge usa el mensaje que genera git («Merge branch…»), que commitlint ignora.
11. ⚠️ **La suite de servidor en PostgreSQL necesita un contenedor** y se salta sola si no hay `NODO_PG_URL` (`pg-smoke.test.ts`; con la variable cada «base en memoria» es un esquema nuevo). Ver «Comandos».
12. ⚠️ **SQLite local es `node:sqlite` (Node ≥ 24), no `better-sqlite3`** (plan 02, D2.1). Dos trampas: Vitest reescribe `import "node:sqlite"` a `sqlite` y falla, por eso `store/sqlite.ts` usa `process.getBuiltinModule("node:sqlite")`; y `node:sqlite` solo acepta `null`, números, texto y binarios (el adaptador convierte booleanos y `undefined`). Imprime un `ExperimentalWarning`: el paquete lo silencia con `--disable-warning=ExperimentalWarning`.
13. ✅ **Una instalación nueva no se siembra** (`seed` y `seed:demo` son solo de desarrollo): el asistente de `/api/setup` crea al administrador. No reintroducir claves de fábrica.
14. ⚠️ **Los respaldos automáticos se llaman `003-…` y las copias previas a migrar `pre-migracion-…`** y tienen retención distinta (14 y 5): no mezclar sus prefijos (`routes/reports.ts`, `db.ts`).
15. 🔴 **La clave privada de licencias no entra al repo ni a la base de un local** (plan 03, I3.2). Va como `HQ_SIGNING_KEY` del HQ; el paquete de producción lleva solo la pública y falla al construirse sin ella. `--license open` produce un paquete `-dev` sin límites que **no se distribuye**.
16. 🔴 **La clave de recuperación de los respaldos nunca va al HQ ni a registros** (plan 04, I4.1/I4.5): el HQ solo guarda texto cifrado. Si se pierde la clave y el equipo, no hay recuperación; no «arreglar» esto guardando la clave en la nube.
17. ⚠️ **`useLive(load, types, deps)`: el segundo argumento son tipos de evento, los `deps` van tercero** (`web/src/api.ts`). Pasar deps como segundo no da error de tipos con `[]`/`string[]` y la carga no se repite al cambiar.
18. ⚠️ **Las bases desechables en PostgreSQL se cierran solas al final de cada archivo de pruebas** (`test/setup.ts`, `closeTempPgDbs`). Antes se filtraban esquemas y conexiones hasta hacer fallar la suite en bloque; si ves cientos de esquemas `t_…` en el contenedor, bórralos uno por uno (no en un bloque).
19. 🔴 **Una mesa abierta sin conexión es una cuenta «sombra» `offline:<id>`** (`web/src/api.ts`): la comanda se enlaza por `accountRef` al reconectar. Cualquier función nueva sobre una cuenta que llame a `/accounts/offline:…` falla con `mesa_sin_sincronizar` a propósito (`api()` lo corta antes de pedir). No «arreglar» creando la cuenta antes: abrir la mesa sin red es exactamente lo que se quiere permitir.
20. ⚠️ **El cajón de dinero es una orden dentro del trabajo de impresión** (`DRAWER_PIN2/5` en `printing/markup.ts`, pulso `ESC p` en `escpos.ts`): viaja por la cola, así que hereda reintento y respaldo. No abrirlo con una conexión aparte.

## Estado

Ver [`docs/ESTADO-ACTUAL.md`](docs/ESTADO-ACTUAL.md). Resumen al 2026-10-03 (rama `feature/fundacion`, sin integrar en `main`): typecheck limpio; 460 pruebas de servidor en SQLite y 461 en PostgreSQL; 110 e2e; `nube-web` integrada; planes 01 a 05 cerrados.

Puertos: servidor de Nodo `3003` (por defecto), HQ `3004`, demo de marisquería `3005`/`3006` (convención de los videos), landing `3000`, e2e de landing `3047`.

## Comandos

Todos desde `003/` salvo que se indique. Con `pnpm` 11 (trampa 1): `p() { npx -y pnpm@11.21.0 "$@"; }`.

```bash
p install
p typecheck                              # los cuatro paquetes
p --filter @003/shared --filter @003/server test      # unitarias en SQLite: ~13 s
p --filter @003/web build                # obligatorio antes de servir o de las e2e
p --filter @003/server seed              # datos mínimos (admin / admin1234; PIN 1111, 2222, 3333)
p --filter @003/server seed:demo         # demo de mariscos (usa DB_FILE y PHOTOS_DIR propios)
p --filter @003/server start             # http://<ip>:3003 (sin base: arranca el asistente de primer arranque)

# Paquete instalable (ver docs/deploy/INSTALACION.md):
p --filter @003/packaging build -- --license open     # paquete de DESARROLLO (-dev), sin límites; no distribuir
p --filter @003/packaging build -- --platform win32 --arch x64 --license-public-key <pem> --hq-url <url>   # producción (necesita makensis para el .exe)
p --filter @003/packaging smoke                       # prueba de humo del paquete -dev
p --filter @003/packaging test                        # el modo de licencia de producción queda fijo
p --filter @003/server keygen -- --out ~/.nodo-keys   # par de claves de licencias (la privada NO va al repo)

# Suite de servidor en PostgreSQL (en lote; ~2 min):
docker run -d --name nodo-pg -e POSTGRES_PASSWORD=nodo -e POSTGRES_DB=nodo_test -p 5433:5432 postgres:16-alpine
NODO_PG_URL=postgres://postgres:nodo@127.0.0.1:5433/nodo_test p --filter @003/server test
```

Para verificar a mano contra la demo **sin tocar `data/`** (usa el scratchpad de la sesión):
`DB_FILE=<dir>/demo.sqlite PHOTOS_DIR=<dir>/photos BACKUP_DIR=<dir>/backups PORT=3005 HOST=127.0.0.1 p --filter @003/server start`.

Formato y lint (desde la raíz del repo): `npm install` (instala Biome, commitlint y husky) · `npm run lint` · `npm run lint:fix` · `npm run format`.

Landing (desde `landing/`): `npm install` · `npm run dev` · `npm run build && npm start`.

## Pruebas

| Nivel | Dónde | Necesita | Cuándo |
|---|---|---|---|
| Unitarias y de API | `003/apps/server/test`, `003/packages/shared/test` | nada | Durante el trabajo, con `tsc` |
| e2e de navegador | `003/apps/e2e/tests` | `p --filter @003/web build`, `cd landing && npm run build`, Chrome (`CHROME_PATH`) | **En lote, al cerrar una fase.** ~5 min en serie. No tras cada cambio. |

`pnpm test` en la raíz corre también las e2e (`pnpm -r test`); para el ciclo corto, filtrar como arriba.

## Convenciones de repo

- **Commits:** Conventional Commits en español (tipos y reglas en la sección 11.2 de la skill). Un commit, una razón; un arreglo y su prueba juntos. Se commitea cuando el dueño lo pide; no se hace push sin que toque.
- **Ramas:** `main` es la base. Una rama por etapa (`feature/<nombre>`, `fix/<nombre>`). `origin/nube-web` es una rama viva con trabajo no integrado (ver `ESTADO-ACTUAL.md`); **integrarla o descartarla es decisión del dueño**.
- **Formato y lint:** Biome (`biome.json`, 2 espacios, ancho 100). En CI solo bloquean los errores; los avisos (accesibilidad, `any`, dependencias de hooks) son deuda para revisar una a una. Hooks de husky: `pre-commit` (Biome sobre lo staged) y `commit-msg` (commitlint).
- **Cerrar una etapa:** casillas del plan con commit, entrada de registro fechada, fila de la tabla de arriba, trampas nuevas aquí, `STRUCTURE.md` si hay carpetas nuevas, memoria al día.
