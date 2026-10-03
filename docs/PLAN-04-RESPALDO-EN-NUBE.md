# Plan 04 — Respaldo cifrado en la nube, restauración y HQ en Railway

> **Etapa abierta** (2026-10-03, rama `feature/fundacion`). Continúa a [`PLAN-03`](PLAN-03-LICENCIAS-Y-ACTIVACION.md). Resuelve D3 (etapa 1) de [`PLAN-00`](PLAN-00-ESTRUCTURA-DE-TRABAJO.md) y el hallazgo E1 de [`ESTADO-ACTUAL`](ESTADO-ACTUAL.md).
>
> 🤖 Sesión autónoma (el dueño duerme): lo abierto lo decide la sesión y queda en el Registro. **No se despliega nada en Railway**: se deja listo y probado en local (Docker).
>
> **Se sigue estrictamente.** Una sesión que retome esto lo lee entero y marca la casilla de cada fase, con su commit, al cerrarla.
>
> ### Cómo empieza la sesión que lo retome
> 1. Leer este documento, `PLAN-00` §5 (D3) y `docs/deploy/LICENCIAS.md`.
> 2. `git status`, `git log --oneline -20`.
> 3. Reverificar: `cd 003 && npx -y pnpm@11.21.0 --filter @003/server test` (407 en verde al abrir este plan) y `docker ps` (contenedor `nodo-pg`).

## 0. El encargo, literal y resumido

> «Un servidor en nube propio de Nodo como una opción para tener backups de información que se sincronizan cuando hay red.» (2026-10-03)

> «D3: lo que veas más conveniente para un software de esta magnitud.» · «La nube de Nodo viviría en Railway.» (2026-10-03)

Resumen (decisión D3 ya tomada): **respaldo completo cifrado en el local, con una llave que Nodo no conoce, subido al HQ cuando hay red, y restaurable en una PC nueva**. Es lo que cierra la pérdida total de datos si se muere el equipo del local (E1).

## 1. Lo que hay hoy (mapa verificado, 2026-10-03)

- Respaldo local automático diario (14) y manual (`createBackup`, `db.backup`), sin salir del equipo; el HQ solo recibe resúmenes de ventas y catálogo.
- No hay restauración guiada: hoy habría que copiar el archivo a mano.
- El HQ corre sobre SQLite (el mismo código y las mismas migraciones); `main.ts` no sabe abrir PostgreSQL aunque la rama `nube-web` (integrada) lo permite.
- Railway: servicio con Postgres y volumen es el destino; la landing ya se despliega allí (`landing/railway.json`).
- Las fotos de platillos viven en `photos/` fuera de la base: un respaldo solo de la base las perdería.

## 2. Decisiones

**D4.1 — El paquete de respaldo = instantánea consistente de la base (`db.backup`) + fotos**, en un contenedor propio (`NODOBK1`) sin dependencias (no hay `tar` portable en Windows). Descartado: subir solo el `.sqlite` (perdería las fotos).

**D4.2 — Cifrado de extremo a extremo con AES-256-GCM por bloques de 1 MiB**, con una **clave de recuperación** de 256 bits generada en el local. El HQ solo guarda texto cifrado: ni Nodo ni quien robe el servidor lee los datos del cliente. Cada bloque lleva su nonce (prefijo aleatorio del archivo + contador) y autentica su posición y si es el último (AAD): un bloque cambiado, reordenado o un archivo truncado **falla al descifrar**. Costo asumido: **si se pierde la clave y el equipo, no hay recuperación** (Nodo no puede ayudar); por eso la clave se muestra una vez, con una pantalla de confirmación. Descartado: guardar la clave en el HQ (Nodo podría leer los datos y cargaría con esa responsabilidad).

**D4.3 — Subida por flujo, no en memoria**, con SHA-256 y tamaño verificados por el HQ, solo para sucursales activas y atadas a su huella. Tope por archivo (512 MB) y cuota por sucursal (5 GB), configurables; los rechazos se dicen con su motivo. Retención en el HQ: 14 diarios más 6 mensuales.

**D4.4 — El local sube solo y sin estorbar**: un proceso de fondo que, tras el respaldo diario o si lleva más de 24 h sin subir, arma el paquete, lo sube y reintenta con espera creciente (hasta 1 h) si no hay red. Estado visible (último éxito, último error, tamaño) en *Configuración → Nube y plan*. Nada de esto bloquea ventas.

**D4.5 — Restauración con un comando** (`server.mjs restore`), pensado para el instalador: activa la PC nueva con un código del propietario (nueva huella, llave rotada), baja el último respaldo, lo descifra con la clave de recuperación, lo verifica (integridad de SQLite y migraciones) y deja el equipo listo. Se niega a sobrescribir una base existente sin `--force`.

**D4.6 — El HQ arranca sobre PostgreSQL con `DATABASE_URL`** (esquema `hq`), guarda los respaldos en un volumen (`NODO_DATA_DIR=/data`) y se despliega con un `Dockerfile` en `003/`. Se prueba construyendo la imagen y corriéndola contra el PostgreSQL de pruebas, **sin desplegar**.

## 3. Invariantes

- **I4.1.** Ningún dato legible del local sale del equipo: lo subido es siempre texto cifrado.
- **I4.2.** Un fallo de la nube (sin red, cuota, HQ caído) nunca afecta la venta ni se queda mudo: queda en el estado visible.
- **I4.3.** Un respaldo manipulado o truncado se detecta al restaurar; nunca se restaura en silencio algo corrupto.
- **I4.4.** Restaurar no pisa una base con datos sin una orden explícita.
- **I4.5.** La clave de recuperación no está en el HQ ni en registros.

## 4. Orden

- [ ] **F4.1 — Cifrado por bloques** (`backup-crypto.ts`) y pruebas de manipulación.
- [ ] **F4.2 — Paquete de respaldo** (base + fotos) y su extracción.
- [ ] **F4.3 — HQ:** migración, subida por flujo, listado, descarga, retención y cuota.
- [ ] **F4.4 — Local:** clave de recuperación, subida automática con reintentos, rutas y estado.
- [ ] **F4.5 — Restauración** (CLI) y prueba de recuperación completa de extremo a extremo.
- [ ] **F4.6 — Pantalla** de respaldo y clave de recuperación.
- [ ] **F4.7 — HQ en producción:** PostgreSQL por `DATABASE_URL`, `Dockerfile`, `railway.json`, guía y prueba de la imagen.
- [ ] **F4.8 — Cierre.**

## 5. Decidido con el dueño

`PLAN-00` §5: D3 por etapas (respaldo completo cifrado y restaurable, luego eventos); nube de Nodo en Railway.

## 6. Registro

*(se rellena al cerrar cada fase)*
