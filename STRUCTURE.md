# STRUCTURE — dónde va cada cosa

Se consulta **antes de crear un archivo**. Gana el repositorio: si discrepa, se corrige este archivo.

Estado al 2026-10-03. La estructura puede cambiar según lo que decida `docs/PLAN-00-ESTRUCTURA-DE-TRABAJO.md`; hasta entonces, esto describe lo que hay.

```text
KYLOO-NODO/
├─ CLAUDE.md            contexto de trabajo, trampas, comandos
├─ STRUCTURE.md         este archivo
├─ README.md            presentación del repo y despliegue de la landing
├─ docs/                TODA la documentación persistente
├─ 003/                 Nodo, el software (monorepo pnpm)
│  ├─ apps/
│  │  ├─ server/        Fastify + SQLite: API REST, WebSocket, impresión, licencias, HQ
│  │  │  ├─ src/        código (rutas en src/routes, impresión en src/printing)
│  │  │  └─ test/       pruebas de servidor (Vitest, base :memory:)
│  │  ├─ web/           PWA React + Vite (vistas en src/views)
│  │  └─ e2e/           pruebas de navegador (puppeteer-core + Vitest)
│  ├─ packages/
│  │  └─ shared/        permisos, máquina de estados de comanda, motor de rutas (lo usan server y web)
│  └─ packaging/        construye el paquete instalable (build.mjs), su prueba de humo (smoke.mjs) y las plantillas de Windows
└─ landing/             página de venta (Next.js 15), se despliega sola en Railway
   ├─ app/              página y estilos
   ├─ components/       video en bucle, olas WebGL, formulario
   ├─ public/           videos .mp4, capturas, logotipos
   └─ video-src/        «película» HTML que renderiza los videos (ver landing/README.md)
```

## Dónde va un archivo nuevo

| Quiero añadir… | Va en… |
|---|---|
| Una ruta de la API | `003/apps/server/src/routes/<dominio>.ts`, registrada en `app.ts`; permiso en `003/packages/shared/src/permissions.ts` |
| Una migración SQL | `003/apps/server/src/schema.ts` (lista ordenada; aditiva por defecto) |
| Una pantalla | `003/apps/web/src/views/<Pantalla>.tsx`, con su ruta en `App.tsx` |
| Lógica compartida servidor-web | `003/packages/shared/src/` (y se exporta en `index.ts`) |
| Una prueba de servidor | `003/apps/server/test/<tema>.test.ts` |
| Una prueba de navegador | `003/apps/e2e/tests/<tema>.test.ts` (reutiliza `harness.ts`) |
| Un plan, auditoría, guion, investigación, decisión | `docs/` (ver `docs/README.md` para nombres) |
| Un procedimiento de instalación o despliegue | `docs/deploy/` |
| Configuración leída del entorno (rutas, puertos) | `003/apps/server/src/config.ts` (un solo sitio) |
| Registros del servidor | `003/apps/server/src/logging.ts` |
| Una trampa que ya mordió | `CLAUDE.md`, sección «Trampas» |
| Un video o captura de la landing | `landing/public/` (los videos se generan desde `landing/video-src/`) |
| Secretos, bases de datos, respaldos | **Nunca al repo** (`.gitignore`: `**/data/`, `*.sqlite*`, `.env*`) |

## Convenciones de nombre

- Ficheros y carpetas de código: inglés, `kebab-case` o `PascalCase` en componentes React, como el código vecino.
- Documentación en `docs/`: `PLAN-<NN>-<TEMA>.md`, `AUDITORIA-<TEMA>.md`, `GUION-<DEMO>.md`, `DECISION-<TEMA>.md`, en mayúsculas y con guiones.
