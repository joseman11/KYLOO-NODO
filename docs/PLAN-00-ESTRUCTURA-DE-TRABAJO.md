# Plan 00 — Estructura de trabajo y rumbo del proyecto

> **Etapa abierta, en conversación** (2026-10-03, rama `main`).
> Es el primer plan del proyecto. Sustituye, como guía de trabajo, a los planes históricos [`PLAN-FASE1`](PLAN-FASE1.md), [`PLAN-FASE2`](PLAN-FASE2.md) y [`PLAN-FASE3`](PLAN-FASE3.md), que se conservan cerrados.
>
> ⚠️ **Todavía no hay decisiones tomadas.** Este documento es el borrador que el dueño y Claude van cerrando conversando. Una decisión solo existe cuando está en la sección 5 con fecha. **No se escribe código de producto hasta que las decisiones de la sección 2 marcadas «bloquea» estén cerradas.**
> 📍 Vive en `docs/` (y no junto al código) porque rige a todo el repositorio.
>
> **Se sigue estrictamente.** Una sesión que retome esto lo lee entero, lee [`ESTADO-ACTUAL.md`](ESTADO-ACTUAL.md) y marca la casilla de cada fase, con su commit, al cerrarla.
>
> ### Cómo empieza la sesión que lo retome
> 1. Leer este documento entero, `CLAUDE.md` y `ESTADO-ACTUAL.md`.
> 2. `git status` y `git log -10`; reverificar la sección 1 con los tres comandos de abajo.
> 3. Mirar la sección 5 («Decidido con el dueño») para no reabrir lo ya cerrado.
> 4. Retomar la conversación por la primera decisión abierta de la sección 2.
>
> **Reverificación en 30 segundos** (fecha de este mapa: 2026-10-03):
> ```bash
> git log --oneline -3 && git branch -a          # ¿sigue main en 1b45563? ¿sigue origin/nube-web?
> cd 003 && npx -y pnpm@11.21.0 --filter @003/server test    # ¿356 en verde?
> ls ../CLAUDE.md ../STRUCTURE.md ../docs
> ```

## 0. El encargo, literal y resumido

**Literal (2026-10-03):**

> «Ponte al día con este proyecto, a partir de ahora trabajaremos en él a nuestro modo […] primero necesito que des una evaluación completa, puesta a punto, y ejecución de este proyecto para poder analizar qué es lo que ya tiene, qué hace, qué tecnologías usa, en qué está destinado, etc. […] después yo te actualizo con la información que tengo y con el rumbo que tomará este proyecto a futuro para que juntos evaluemos el mejor *approach*.»

> «El rumbo, se espera venderse como ambas [local y nube], pero es importante que funcione sin conexión directa a internet para situaciones en las que se va la conexión o similares, siendo un servidor en nube propio de nodo una opción para tener backups de información que se sincronizan cuando hay red, así como el hecho de futuras timbres PAT [PAC] necesitarían de un servidor o similar.»

> «Aún no hay clientes.»

> «Quiero que prepares todo este repositorio listo para nuestro modo de operación con directorio docs para TODA la documentación persistente, planes de iteración (de momento solo el plan 00 donde creamos la estructura de trabajo y definimos lo que haremos y cómo lo haremos (esto tomará un rato de charlar tú y yo hasta llegar a un acuerdo claro y profundo de todo lo que se hará)».

> «No veo necesario que corrijas los rojos ahora, aún falta ver bien qué haremos, veo como una posibilidad migrar de tecnologías (aunque aún depende de nuestra charla).»

> «Veo que hay mucho trabajo que hacer, re-organizar, refactorizar, etc.»

**Resumen.** Dejar el repo en orden de trabajo (hecho, sección 4 F0) y usar este plan para acordar, conversando, tres cosas: **a dónde va el producto** (local + nube, siempre operable sin internet), **con qué tecnología** (migrar o no) y **en qué orden se hace el trabajo** (reorganizar, refactorizar, planes siguientes).

## 1. Lo que hay hoy (mapa verificado, 2026-10-03)

Detalle completo, con medidas, en [`ESTADO-ACTUAL.md`](ESTADO-ACTUAL.md). Lo que condiciona este plan:

- Producto con tres fases funcionales construidas y **sin clientes**: es el mejor momento para cambiar cimientos, porque no hay datos reales que migrar ni usuarios a los que no romper.
- **Local-first de verdad:** Fastify + SQLite por local, PWA por LAN, impresión por TCP 9100, licencia que nunca detiene la venta.
- **La «nube» actual es un HQ de resúmenes**, no un respaldo (`ESTADO-ACTUAL` §4): no sale de la sucursal la base, ni las comandas.
- **`origin/nube-web`** ya trae la abstracción de datos asíncrona y un motor PostgreSQL (un esquema por restaurante) con la suite entera pasando en ambos motores (§5 de `ESTADO-ACTUAL`). Es una de las rutas posibles, ya construida a medias.
- Base de código **pequeña** (≈13k líneas de aplicación, 5k de pruebas) y bien cubierta por pruebas de servidor: refactorizar o migrar es barato comparado con lo habitual, y las pruebas son la red.
- Dos e2e rojas y un typecheck roto, **adrede sin tocar** hasta decidir el rumbo.

## 2. Decisiones por cerrar

Cada una lleva mi **recomendación** y la alternativa descartada. Todas son para conversar; las marcadas **bloquea** deben cerrarse antes de escribir código de producto.

### D1 — Qué significa «sin conexión» ✅ cerrada 2026-10-03
**Propuesta:** el local es **autosuficiente**: vender, enviar a cocina, imprimir, cobrar, abrir y cerrar caja, inventario y reportes funcionan siempre sin internet. La nube **añade** (respaldo, multi-sucursal, consola, timbrado), nunca es requisito para operar.
Por cerrar: ¿hay algo que **sí** se acepte que exija internet (timbrar una factura, activar licencia por primera vez, actualizar software)? Recomiendo: sí a los tres, con cola y reintento visibles (regla «un recorte mudo es peor que no recortar»): el sistema dice cuántas facturas esperan timbre.

### D2 — Modelo de despliegue: ¿qué corre dónde? ✅ cerrada 2026-10-03 (opción A)
Opciones:
- **A. Local con respaldo en nube** (el rumbo descrito): servidor en el local; la nube recibe copias y sirve de HQ y de timbrado.
- **B. Nube con local degradado**: la fuente de verdad está en la nube; el local guarda caché y cola. Más simple de operar para nosotros, pero el local es peor «sin internet» y contradice la prioridad del dueño.
- **C. Dos productos con un mismo código** (el de `nube-web`): el mismo servidor corre en el local (SQLite) o en la nube (PostgreSQL, un esquema por restaurante), y se **sincronizan**.

**Recomendación: A como producto, apoyado en C como base técnica.** Es decir: el local siempre es dueño de sus datos; la nube es una réplica (más HQ, más timbrado). Descarto B porque rompe la prioridad. Por conversar: ¿«venderse como ambas» significa que habrá clientes **solo nube** (sin servidor en su local) además de los locales? Si sí, C deja de ser opcional.

### D3 — Sincronización local → nube ✅ decidida 2026-10-03 por delegación del dueño
Hoy se envía un resumen de ventas. Falta decidir **qué** se replica y **cómo**:
- Respaldo de la base completa cifrado (simple, no sirve para consultar).
- Replicación por eventos/registro de cambios (sirve para reportes y HQ; más trabajo; exige identificadores globales y resolución de conflictos).
**Recomendación:** empezar por **respaldo cifrado completo y periódico** (resuelve E1, la pérdida de datos), y diseñar el registro de eventos solo cuando el HQ lo necesite de verdad. Preguntas: ¿cuánto dato se acepta perder (RPO)? ¿se restaura en un equipo nuevo desde la nube (recuperación de desastre)? ¿quién cifra y con qué llave?

### D4 — Timbrado fiscal (PAC) ✅ cerrada 2026-10-03 (timbra el local)
El PAC exige servidor y conexión. Opciones: el local timbra directo contra el PAC cuando hay red (cola local) o el local manda a **nuestro servidor** y este timbra (el PAC ve una sola cuenta, nosotros guardamos credenciales de varios clientes → responsabilidad y seguridad mayores). Faltan: elegir PAC, entender el modelo comercial (¿revendemos timbres?) y qué obligaciones fiscales implica. **No decido solo:** es del dueño (dinero y obligaciones legales). Mientras tanto se mantiene `InvoiceProvider` con el proveedor de prueba.

### D5 — Tecnología: ¿se migra algo? ✅ cerrada 2026-10-03 (el servidor no se migra)
Hoy: TypeScript, Fastify, SQLite síncrono, React/Vite, sin ORM ni linter. **Mi lectura, antes de oír al dueño:** el stack **no es el problema**. Lo que sí pesa es (a) la capa de datos síncrona, que impide un segundo motor (por eso existe `nube-web`), (b) la ausencia de linter, CI y convenciones automáticas, y (c) archivos grandes (`seed-demo.ts`, `operations.ts` de ≈460 líneas cambiadas en `nube-web`). Migrar el lenguaje o el framework sin un dolor medido me parece costoso y sin retorno; **antes de aceptar una migración quiero saber qué la motiva** (¿empaquetado de escritorio? ¿rendimiento? ¿contratar gente con otro stack? ¿app nativa?). Candidatos a discutir con criterio, no por moda: ORM/constructor de consultas (Drizzle, ya previsto en `PLAN-FASE1`) frente a SQL a mano portable; Next.js para la app en vez de Vite+PWA; empaquetar el servidor como binario o instalador.

### D11 — Cómo se distribuye el cliente en tablets y PC (bloquea F5)
Hoy: PWA servida por el propio servidor, sin instalar nada. Hallazgo: **sobre `http://<ip>:3003` el navegador no la trata como contexto seguro**, así que el service worker no se registra (`main.tsx` lo exige) y no se puede instalar como app. Opciones: (1) PWA con HTTPS local (CA propia instalada en cada tablet, o dominio público apuntando a IP privada, que falla sin DNS cuando se cae internet); (2) **envoltorio nativo** (Capacitor o Tauri móvil) que carga la web desde el servidor, da modo kiosco, descubre el servidor, guarda la cola offline en almacenamiento nativo, resuelve el contexto seguro y abre la puerta a Bluetooth; (3) PWA sin HTTPS (descartada: deja sin caché y sin instalación).
**Recomendación (sin recortar por ser «MVP»):** construir **(2)** como cliente de tablet de primera clase y mantener la PWA para cualquier navegador (PC de caja, un teléfono prestado). La elección entre Capacitor y Tauri móvil se hace con un **spike medido** en tablets reales baratas antes de F5. Una app de PC con Tauri como escritorio de caja queda abierta.

### D12 — Resiliencia offline y continuidad (bloquea F5)
Tres fallos distintos: (a) **se cae internet** → no afecta (todo es LAN, I1); (b) **la tablet pierde la red local**; (c) **se cae el servidor del local**. Diseño completo, no mínimo:
- **(b)** Cola de operaciones **completa** y durable (IndexedDB o almacenamiento nativo) con id por operación: abrir mesa, pedir, modificar, pedir cuenta, transferir. Menú, mesas y precios en caché durable con versión. Indicador visible de «sin conexión» y de cuántas operaciones esperan. Reglas de conflicto escritas.
- **(c)** Reinicio automático, UPS, aviso en cada dispositivo de «servidor caído», restauración guiada desde respaldo en minutos y **servidor de reserva** (otra PC del local en espera con réplica continua) como componente del diseño, no como extra opcional. Se decide en F5 cómo se promueve (manual con un botón, o automático).
- Una prueba por forma de fallo: cortar el WiFi a media comanda, matar el servidor, reiniciarlo, cortar la luz (kill -9) y comprobar que no se pierde ni se duplica nada.

### D13 — Licencias y activación: protección y proceso ✅ resuelta 2026-10-03 (`PLAN-03`)
Hallazgo (`ESTADO-ACTUAL` E22): la licencia hoy **no resiste a quien quiera saltársela** (clave pública en la base editable, valor por defecto sin límites, código fuente en el equipo). Un software que se instala en el equipo del cliente **no puede hacerse inviolable**; se diseña para que saltárselo cueste más que pagarlo y para que lo valioso **no viva en el local**. Propuesta: (1) clave pública **incrustada en el ejecutable**, nunca en la base ni descargada del servidor que teclea el usuario; (2) licencia firmada (Ed25519, ya existe) **atada a un identificador del equipo** y a la sucursal, con vencimiento; (3) **sin licencia = plan restringido**, no ilimitado; (4) activación con un **código de un solo uso** que emite el panel de Nodo (organización → sucursal → código) y que se canjea por internet una vez; después el local opera sin red; (5) renovación y revocación por la nube con gracia larga, **sin detener nunca la venta** (I3); (6) el valor no copiable: respaldo y restauración en nube, actualizaciones, soporte, consola multi-sucursal; (7) ejecutable compilado y ofuscado como freno, sin fingir que es una barrera; (8) contrato. Por cerrar con el dueño: modelo comercial (suscripción o pago único), qué pasa con un equipo que se cambia, y cuánto freno es aceptable frente a la fricción de instalación.

### D6 — `nube-web`: integrar, rehacer o descartar (decide el dueño)
Recomendación condicionada a D2/D5: si se elige A/C, **integrarla** (es exactamente la base), pero **antes** resolver los rojos de e2e y revisar su cambio de 2965 líneas con pruebas, porque convierte toda la aplicación a async. Si se elige otra ruta, se archiva como rama `backup-nube-web` y se anota.

### D7 — Empaquetado y operación del servidor en el local
Hoy: Windows + tarea programada por PowerShell. Faltan: instalador, actualizaciones (¿remotas desde la nube?), copia automática fuera del equipo, monitoreo. Preguntas: ¿solo PC con Windows en el local o también mini-PC Linux / Mac? ¿quién instala (nosotros o el cliente)?

### D8 — Calidad y flujo de trabajo (propongo, se aprueba)
- **Biome** (2 espacios, ancho 100) y **commitlint** con los tipos de la skill; hook con husky.
- **CI** (GitHub Actions): typecheck, unitarias y build en cada PR; e2e en lote manual o nocturno.
- **Una rama por etapa**, commits pequeños, e2e al cerrar fases, nunca `retries`.
- Medir antes y después en cada cambio de arquitectura (tamaño, latencia, RAM).
- Formateo masivo en **un commit aparte** (`style`) para no ensuciar el historial.

### D9 — Seguridad y datos
Antes de tener clientes: revisar límite de intentos de PIN, JWT en `localStorage`, secretos del HQ (`HQ_ADMIN_TOKEN`), cifrado del respaldo, política de datos personales (clientes, fiscales). Propongo una **auditoría de seguridad** como etapa propia, antes del primer piloto.

### D10 — Producto: piloto y orden comercial (del dueño)
Sin clientes. Preguntas: ¿quién es el primer restaurante (hay uno en mente)? ¿qué se promete en la landing hoy y no existe todavía (nube, facturación real)? ¿qué se enseña en demo? Recomiendo **cerrar un piloto real pronto**, porque el mayor riesgo de un producto con tres fases y cero clientes es construir lo que nadie pidió.

## 3. Invariantes

Lo que ninguna fase puede romper.

- **I1.** La operación de un local (pedir, cocinar, imprimir, cobrar, cerrar caja) funciona sin internet. Hay una prueba que lo demuestra.
- **I2.** Nunca se pierde una comanda ni un cobro (cola de impresión persistente, pagos idempotentes).
- **I3.** Una licencia vencida **nunca detiene la venta**.
- **I4.** Sin migraciones destructivas sin avisar; copia antes de migrar.
- **I5.** Un cambio de arquitectura no cambia el comportamiento visible: las pruebas (unitarias y e2e) dan lo mismo antes y después.
- **I6.** Nada de datos reales, secretos ni bases en git.
- **I7.** Lo escrito en un catálogo (permiso, función de plan, límite) se aplica en el mismo commit.

## 4. Orden

> Fases con casilla. Se marca al cerrar, con el commit. El orden de F2 en adelante depende de las decisiones de la sección 2.

- [x] **F0 — Repositorio listo para trabajar a nuestro modo** (2026-10-03). `CLAUDE.md`, `STRUCTURE.md`, `docs/` con índice, `ESTADO-ACTUAL.md` y este plan; documentación histórica movida a `docs/` y marcada; duplicado `DESIGN (2).md` retirado. *Sin commitear aún* (el dueño lo pide cuando quiera).
- [ ] **F1 — Conversación y acuerdo** (esta etapa; D1–D4 cerradas el 2026-10-03). Cerrar D5–D10 con el dueño; cada una pasa a la sección 5 con fecha. Se comprueba cuando no quede ninguna «bloquea» abierta.
- [x] **F2 — Línea base verde** (2026-10-03, `PLAN-01`). Diagnosticar y arreglar las 2 e2e rojas, el typecheck de e2e, la ruta de Chrome en macOS y las rutas de Windows de `video-src`. Tras decidir D6 (porque `nube-web` toca esas pruebas). *Pide:* D6.
- [x] **F3 — Herramientas de calidad** (2026-10-03, `PLAN-01`). Biome, commitlint, hook, CI (D8). Formateo en un commit aparte.
- [ ] **F4 — Reorganización y refactor.** Según D5 y el análisis de archivos grandes; con pruebas como red e I5 como criterio. Se detalla en su propio plan (`PLAN-01`) cuando F1 cierre.
- [ ] **F5 — Plan 01 (primera iteración de producto o de arquitectura).** Lo que salga de D2/D3: probablemente respaldo en nube y capa de datos. *Pide:* D2, D3, D5.
- [ ] **F6 — Seguridad (D9) y piloto (D10).**

## 5. Decidido con el dueño


| Fecha | Decisión | Qué se descartó y por qué |
|---|---|---|
| 2026-10-03 | Se vende como **local y nube**; el local debe operar sin conexión; la nube propia de Nodo sirve de respaldo sincronizado y de apoyo al timbrado (PAC). | — |
| 2026-10-03 | No se corrigen los rojos de e2e hasta definir el rumbo. | Arreglarlos ya (podrían rehacerse si se migra). |
| 2026-10-03 | Toda la documentación persistente vive en `docs/`; planes de iteración numerados, empezando por el 00. | Documentación junto a cada pieza (`003/docs`). |
| 2026-10-03 | Aún no hay clientes. | — |
| 2026-10-03 | **D1.** El local es autosuficiente. Solo timbrar facturas, la primera activación de licencia y las actualizaciones exigen internet, con cola y reintento **visibles** (cuántas facturas esperan timbre). La nube añade, nunca es requisito. | Que la operación dependa de la nube (opción B de D2). |
| 2026-10-03 | **D2 = opción A.** Servidor en una PC del local, dueño de sus datos, con **réplica en servidores de Nodo** (respaldo, HQ). | B (nube como fuente de verdad, local degradado): rompe la prioridad de operar sin internet. |
| 2026-10-03 | **D3 (delegada al dueño: «lo que veas más conveniente»).** Por etapas: **(1)** respaldo completo, **cifrado en el local** con llave del cliente, subido periódicamente a Nodo y **restaurable en una PC nueva** (recuperación de desastre); **(2)** solo cuando el HQ lo necesite, replicación por registro de eventos con identificadores globales, para reportes multi-sucursal. Sin datos legibles por Nodo salvo los resúmenes que el cliente ya envía. | Empezar por replicación de eventos: más trabajo, exige resolución de conflictos y no resuelve antes la pérdida de datos (E1). |
| 2026-10-03 (sesión autónoma) | **D6.** `nube-web` **se integra** en la rama de sesión (opción A de D2). Verificada en SQLite y PostgreSQL antes de seguir. | Dejarla viva en su rama o descartarla. |
| 2026-10-03 (sesión autónoma) | **D13.** Licencia atada al equipo, clave pública incrustada, activación por código de un solo uso, sin licencia = plan gratuito sin detener la venta (`PLAN-03`, `deploy/LICENCIAS.md`). | Variable de entorno para apagar la licencia; clave pública descargada del HQ. |
| 2026-10-03 (sesión autónoma) | **D8.** Biome + commitlint + husky + CI (GitHub Actions); formateo masivo en un commit aparte. | Sin herramientas automáticas. |
| 2026-10-03 | **D5.** El servidor **no se migra** (sigue Node + TypeScript + Fastify + SQLite). Se revisa con evidencia del piloto; un agente nativo de hardware (Rust o Go) solo si el piloto lo exige. Hardware objetivo: **económico**, por tanto el sistema se optimiza y se mide en equipos de gama baja. | Reescribir en Rust o Go: el servidor mide 93 MB en reposo y sirve ~1.5k peticiones/s en un reporte real; el cuello de botella de tablets baratas está en el cliente, no en el servidor. |
| 2026-10-03 | **D5 (cierre).** Se permanece en Node y **se empaca el servidor** como ejecutable/instalador sin dependencias. Rust queda como plan B solo si el empaquetado medido sale mal. | Migrar a Rust ahora (ver fila anterior de D5). |
| 2026-10-03 | **Instalación:** la hace el dueño en los primeros locales, **pero el proceso debe quedar pulido** como si lo hiciera el cliente. | Instalación manual con herramientas de desarrollo en el local. |
| 2026-10-03 | **Impresoras: todas por red (Ethernet/WiFi, TCP 9100).** USB no es requisito. | Soportar USB. |
| 2026-10-03 | **Bluetooth queda fuera del alcance actual** (plan futuro). **Todo lo demás se planea y se construye completo desde el inicio**, sin recortar por ser «MVP». | Recortar funciones por etapa de producto. |
| 2026-10-03 | **D4.** **Timbra el local** contra el PAC cuando hay red; Nodo no guarda credenciales fiscales de los clientes ni timbra por ellos. Elegir PAC queda pendiente (con el dueño). | Timbrar desde servidores de Nodo: carga fiscal, de seguridad y de responsabilidad sobre Nodo. |

## 6. Registro

- **2026-10-03** — Evaluación inicial y preparación del repositorio (F0).
  - **Hecho:** evaluación completa del proyecto; creados `CLAUDE.md`, `STRUCTURE.md`, `docs/README.md`, `ESTADO-ACTUAL.md` y este plan; `git mv` de `003/docs/*` a `docs/` (`PLAN.md` pasa a `PLAN-FASE1.md`) con cabecera de «cerrado/histórico»; retirado `DESIGN (2).md` (idéntico, byte a byte, a `DESIGN-reference-brex.md`); enlaces de `README.md` y `003/README.md` corregidos. *Sin commit.*
  - **Medido:** `main` instala y compila; 356/356 pruebas de shared y server; e2e 90/92; typecheck de e2e falla (detalle en `ESTADO-ACTUAL` §6).
  - **Salió por el camino:** `pnpm` 9 global frente al 11.21 exigido; `corepack` fuera del PATH; Chrome sin ruta de macOS en el arnés; `npm install` de `landing` reescribe su lockfile; rutas de Windows en `video-src` (todas en `CLAUDE.md`, trampas 1–6).
  - **Encontrado de paso, anterior a esta etapa y sin arreglar aquí:** dos e2e rojas y typecheck de e2e roto (F2); el HQ envía solo resúmenes y no respalda datos (D3).
  - **Estado de la máquina:** servidor de demo parado; `003/node_modules`, `landing/node_modules`, `.next` y `003/apps/web/dist` creados localmente (ignorados por git); demo sembrada solo en el scratchpad de la sesión, no en el repo.

### Cómo retomarlo
1. Leer las secciones 2 y 5. Preguntar al dueño por la primera decisión «bloquea» aún abierta, con la recomendación a mano.
2. Cada vez que se cierre una, pasarla a la sección 5 con fecha y alternativa descartada, y actualizar la memoria si cambia el rumbo.
3. Cuando D1–D3 y D5 estén cerradas, abrir `PLAN-01` con el encargo literal de la primera iteración.

### Pendiente
- 🔴 **Sin probar:** que los rojos de e2e sean los mismos con y sin `nube-web`; que PostgreSQL funcione en este equipo (no se ejecutó la suite con `NODO_PG_URL`).
- Todo lo de la sección 2.
- Commit de F0 (decide el dueño cuándo).
