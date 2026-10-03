# KYLOO-NODO — Contexto de trabajo

**Nodo** es un comandero (POS de restaurante) que funciona **sin internet**: un servidor en el local es la fuente de verdad y tablets, cocina y caja son navegadores en la misma red. Este repo contiene el software (`003/`) y su página de venta (`landing/`). Se venderá en dos modalidades, local y nube, y la operación del local **nunca puede depender de internet**.

**Nuestro trabajo es todo el repositorio** (servidor, app web, landing, pruebas, documentación y despliegue). No hay equipo ajeno: no existe un backend de otro equipo que consumir.

> [!IMPORTANT]
> El método de trabajo general vive en la skill `kyle-from-kyloo` (`/Users/ander/Software/Tools/KYLOO-TOOLS/skills/kyle-from-kyloo/SKILL.md`). **Este `CLAUDE.md` manda en lo específico del repo** (comandos, trampas, rutas); la skill manda en el método. Si chocan, gana el repo y la diferencia se anota aquí.

## Documentos de referencia

| Documento | Estado | Cuándo consultarlo |
|---|---|---|
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

1. ⚠️ **`pnpm` global del equipo es 9.0.0 y el proyecto exige 11.21.0** (`003/package.json`, `packageManager`). `corepack` no está en el PATH. Atajo que funciona: `npx -y pnpm@11.21.0 <comando>` (en `/Users/ander/.local/opt/node-v24.21.0-darwin-arm64/bin` hay un `pnpm` 9). No da error de versión: simplemente instala distinto.
2. ⚠️ **Las e2e solo buscan Chrome en rutas de Windows/Linux** (`003/apps/e2e/tests/harness.ts`). En macOS: `CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`. Sin ello, `launch()` falla al abrir el navegador.
3. 🔴 **`pnpm typecheck` en la raíz falla en `apps/e2e`** (2026-10-03): a su `tsconfig` le falta `DOM.Iterable` (`TS2488` sobre `NodeListOf`) y `fastify` no es dependencia declarada del paquete (`TS2307`). Los otros tres paquetes pasan. Abierto, ver `ESTADO-ACTUAL.md`.
4. 🔴 **Dos e2e rojas en `main`** (2026-10-03), reproducibles en aislado: `servicio.test.ts` «cobra en efectivo con cambio…» (`Tiempo agotado esperando: texto «Cambio»`) y `configuracion.test.ts` «la lista muestra a todo el personal…» (`Juan: expected false to be true`). Causa sin investigar. **No atribuirlas a un cambio en curso.** La rama `origin/nube-web` modifica esas dos pruebas.
5. ⚠️ **`npm install` en `landing/` reescribe `package-lock.json`** (quita 3 líneas; npm 11 vs el que lo generó). No es un cambio real: `git checkout landing/package-lock.json` antes de commitear.
6. ⚠️ **`landing/video-src/*.mjs` tiene rutas absolutas de Windows** (`C:/Users/Josem/Desktop/AGEN/Restaurantes/003/...` y `C:/Program Files/Google/Chrome/...`). Regenerar los videos en otro equipo falla hasta ajustarlas.
7. ⚠️ **`landing/` se despliega aparte** (Railway, Root Directory `/landing`); `003/` no tiene Dockerfile ni despliegue en nube en `main`. La landing se construye con `NEXT_PUBLIC_*` leídas **al compilar**: cambiar una variable exige redesplegar.
8. ✅ **Cada archivo de e2e levanta su propio servidor con base `:memory:` y la demo de mariscos** (`harness.ts`): no ensucian estado entre archivos ni tocan `data/`. Se corren en serie (`fileParallelism: false`). No cambiarlo.

## Estado

Ver [`docs/ESTADO-ACTUAL.md`](docs/ESTADO-ACTUAL.md). Resumen al 2026-10-03: `main` compila, 356/356 pruebas de shared y server en verde, e2e 90/92 (dos rojas, trampa 4), tres commits de historia.

Puertos: servidor de Nodo `3003` (por defecto), HQ `3004`, demo de marisquería `3005`/`3006` (convención de los videos), landing `3000`, e2e de landing `3047`.

## Comandos

Todos desde `003/` salvo que se indique. Con `pnpm` 11 (trampa 1): `p() { npx -y pnpm@11.21.0 "$@"; }`.

```bash
p install
p typecheck                              # raíz: hoy falla en e2e (trampa 3)
p --filter @003/shared --filter @003/server test      # unitarias: ~13 s, 356 pruebas
p --filter @003/web build                # obligatorio antes de servir o de las e2e
p --filter @003/server seed              # datos mínimos (admin / admin1234; PIN 1111, 2222, 3333)
p --filter @003/server seed:demo         # demo de mariscos (usa DB_FILE y PHOTOS_DIR propios)
p --filter @003/server start             # http://<ip>:3003
```

Para verificar a mano contra la demo **sin tocar `data/`** (usa el scratchpad de la sesión):
`DB_FILE=<dir>/demo.sqlite PHOTOS_DIR=<dir>/photos BACKUP_DIR=<dir>/backups PORT=3005 HOST=127.0.0.1 p --filter @003/server start`.

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
- **Formato:** hoy no hay linter ni formateador en el repo. La adopción de uno se decide en `PLAN-00`.
- **Cerrar una etapa:** casillas del plan con commit, entrada de registro fechada, fila de la tabla de arriba, trampas nuevas aquí, `STRUCTURE.md` si hay carpetas nuevas, memoria al día.
