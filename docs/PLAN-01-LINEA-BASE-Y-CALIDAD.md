# Plan 01 — Línea base verde, `nube-web` integrada y herramientas de calidad

> **Etapa cerrada** (2026-10-03, rama `feature/sesion-autonoma-2026-10-03`). Continúa a [`PLAN-00`](PLAN-00-ESTRUCTURA-DE-TRABAJO.md) (fases F2 y F3, decisiones D6 y D8).
>
> 🤖 **Sesión autónoma:** el dueño duerme. Lo que el plan dejaba abierto lo decide la sesión con las recomendaciones del Plan 00 y lo anota en el Registro. Todo en local, sin push ni despliegue, en commits pequeños y separables.
>
> **Se sigue estrictamente.** Una sesión que retome esto lo lee entero y marca la casilla de cada fase, con su commit, al cerrarla.
>
> ### Cómo empieza la sesión que lo retome
> 1. Leer este documento, `PLAN-00` y `ESTADO-ACTUAL.md`.
> 2. `git status`, `git log --oneline -20` y `git branch` (¿estoy en la rama de la sesión?).
> 3. Reverificar: `cd 003 && npx -y pnpm@11.21.0 --filter @003/server test` y `docker ps` (PostgreSQL de pruebas: contenedor `nodo-pg`, puerto 5433).

## 0. El encargo, literal y resumido

> «Procede a trabajar […] trabaja tantos planes como quieras, no te limites solo al plan 1, usa tu criterio propio para analizar cómo iterar para obtener los mejores resultados.» (2026-10-03)

> «Todo tu trabajo que trabajemos en esta sesión trabájalo en una sola rama para poder evaluarla después.» (2026-10-03)

Resumen: dejar una base sólida antes de construir encima: integrar la capa de datos de la nube, poner en verde lo que está rojo, y dotar al repositorio de las herramientas que hacen cumplir el método.

## 1. Lo que hay hoy (mapa verificado, 2026-10-03)

- `main` tenía 2 e2e rojas y el typecheck de `apps/e2e` roto (`CLAUDE.md`, trampas 3 y 4).
- `origin/nube-web` (2 commits) convierte el acceso a datos a una interfaz asíncrona `Store` y añade un motor PostgreSQL.
- Integrada la rama en la de la sesión (merge `--no-ff`, para poder revertirla de una sola vez): **typecheck limpio en los tres paquetes, 350/350 pruebas de servidor en SQLite y 351/351 en PostgreSQL 16** (contenedor `nodo-pg`). El único fallo en SQLite es `pg-smoke.test.ts`, que exige un PostgreSQL levantado.
- Sin linter, formateador, CI ni hooks.

## 2. Decisiones

**D1.1 — `nube-web` se integra ahora y antes de formatear.** Es la base de la opción A (D2) y toca 64 archivos: formatear antes habría multiplicado los conflictos. Descartado: dejarla viva en su rama (divergiría más cada día).

**D1.2 — Las pruebas que necesitan PostgreSQL no entran en el ciclo corto.** `pg-smoke.test.ts` se salta si no hay `NODO_PG_URL`/`TEST_DATABASE_URL`. La suite completa en PostgreSQL se corre en lote al cerrar cada plan que toque datos (`docker run … postgres:16-alpine`, ver `CLAUDE.md`). Es la regla de la skill: lo que necesita infraestructura no va en `pnpm test`.

**D1.3 — Biome + commitlint + husky + CI, con la configuración de la skill** (2 espacios, ancho 100). El formateo masivo va en **un solo commit `style`**, al final, con las pruebas en verde antes y después como criterio (I5).

**D1.4 — Las rutas absolutas pasan a variables de entorno con valor por defecto sensato** (`CHROME_PATH`, carpeta de la app y de las fotos) en `harness.ts` y en `video-src`, sin romper el uso en Windows del autor.

## 3. Invariantes

- **I5 (plan 00):** ningún cambio de comportamiento visible; la suite da lo mismo antes y después.
- **I1.1.** Las 351 pruebas de servidor pasan en SQLite **y** en PostgreSQL al cerrar el plan.
- **I1.2.** El formateo no se mezcla con cambios de lógica.

## 4. Orden

- [x] **F1.1 — Integrar `nube-web`** (`merge` sobre la rama de la sesión). Verificada en SQLite y PostgreSQL. `e6c9057`.
- [x] **F1.2 — Diagnóstico y arreglo de las e2e rojas y del typecheck de e2e.** `b5fefca`, `7ae9486`.
- [x] **F1.3 — Rutas portables** (Chrome, `video-src`) y `pg-smoke` condicionado. `f13b2c1`, `d014f99`.
- [x] **F1.4 — Biome, commitlint, husky, CI.** `ab1a3f4`, `332f3e7`.
- [x] **F1.5 — Formateo masivo** (un commit `style`). `b8366b4`.
- [x] **F1.6 — Cierre:** registro, `CLAUDE.md`, `ESTADO-ACTUAL.md`.

## 5. Decidido con el dueño

Ver `PLAN-00` §5 (D1 a D5, instalación, impresoras de red, Bluetooth fuera, sin recortes por «MVP»). Nube de Nodo en **Railway**; **licencia atada al equipo**; modelo comercial sin definir (pendiente); modelo de impresora sin definir (pendiente).

## 6. Registro

- **2026-10-03 (noche, sesión autónoma)** — Cierre del plan.
  - **Hecho:** F1.1 a F1.6 (commits en las casillas).
  - **Medido:** antes, `main` con e2e 90/92 y typecheck de e2e roto; después, typecheck limpio, 350 pruebas de servidor en SQLite, 351 en PostgreSQL 16 y 92/92 e2e, **también tras el formateo masivo** (+25.5k −6.0k líneas en 133 archivos, solo formato).
  - **Diagnóstico de los dos rojos (no eran de producto):**
    1. «cobra en efectivo con cambio»: `Control+A` en macOS no selecciona; el importe tecleado se anexaba (`1035.002000`) y no había cambio. Arreglo: `selectAll()` con `.select()` del campo.
    2. «la lista muestra a todo el personal»: Chrome sin cabeza en macOS dibuja a ~8 cuadros por segundo; hasta el primer cuadro el contenedor medía 0×0 y la paginación mostraba una fila por página (parpadeo de más de 400 ms). Arreglo de producto: `fit.tsx` no pinta hasta medir; arreglo de prueba: `settle()`. Esto importa para tablets baratas: **la app debe comportarse bien a pocos cuadros por segundo.**
  - **Salió por el camino:**
    - El formateador de Biome no es idempotente a la primera en cadenas de métodos; hay que repetirlo (`CLAUDE.md`, trampa 9).
    - `pnpm test` fallaba sin PostgreSQL por `pg-smoke`; ahora se salta sin URL.
    - Los hooks de husky ya validan los commits de esta sesión; el commit de merge anterior a los hooks usa el tipo `merge`, no válido, y queda como está (historia).
  - **Decisiones tomadas por la sesión (con las recomendaciones del plan 00):** D6 integrar `nube-web`; D8 adoptar Biome + commitlint + husky + CI. Lo del plan sigue.
  - **Encontrado de paso, anterior a esta etapa y sin arreglar aquí:** los avisos de Biome (≈ 100 de accesibilidad, `any` y dependencias de hooks) quedan como deuda a revisar una a una (`ESTADO-ACTUAL`).
  - **Estado de la máquina:** contenedor `nodo-pg` (PostgreSQL 16, puerto 5433) en marcha; conviene pararlo con `docker rm -f nodo-pg` si no se usa.

### Cómo retomarlo
Plan 01 cerrado. Seguir con `PLAN-02` (empaquetado e instalación).

### Pendiente
- Activar el repositorio en GitHub Actions y comprobar que `ci.yml` pasa (no se pudo probar en local).
- Decidir si se revisan los avisos de accesibilidad de Biome en una etapa propia.
