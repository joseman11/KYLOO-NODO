# Plan 03 — Licencias atadas al equipo y activación por código

> **Etapa abierta** (2026-10-03, rama `feature/fundacion`). Continúa a [`PLAN-02`](PLAN-02-EMPAQUETADO-E-INSTALACION.md). Resuelve D13 de [`PLAN-00`](PLAN-00-ESTRUCTURA-DE-TRABAJO.md) y el hallazgo E22 de [`ESTADO-ACTUAL`](ESTADO-ACTUAL.md).
>
> 🤖 Sesión autónoma (el dueño duerme): lo abierto lo decide la sesión y queda en el Registro.
>
> **Se sigue estrictamente.** Una sesión que retome esto lo lee entero y marca la casilla de cada fase, con su commit, al cerrarla.
>
> ### Cómo empieza la sesión que lo retome
> 1. Leer este documento, `PLAN-00` §2 (D13) y `ESTADO-ACTUAL.md` (E9 y E22).
> 2. `git status`, `git log --oneline -20`.
> 3. Reverificar: `cd 003 && npx -y pnpm@11.21.0 --filter @003/server test` (376 en verde al abrir este plan).

## 0. El encargo, literal y resumido

> «¿Es seguro a nivel de que no nos crackeen la licencia? Como proveedores del servicio creo que se necesita una forma más eficiente del proceso.» (2026-10-03)

> «Sí, licencia atada al equipo.» · «Nube de Nodo viviría en Railway.» · «Ni idea del modelo» (comercial). (2026-10-03)

Resumen: que una licencia no se pueda fabricar ni copiar entre locales sin esfuerzo desproporcionado, que activar un local sea **un código que se canjea una vez**, y que nada de esto pueda detener jamás la venta de un restaurante (I3 del plan 00). El modelo comercial (suscripción o pago único) queda abierto: la licencia ya lleva plan y vencimiento y sirve para ambos.

## 1. Lo que hay hoy (mapa verificado, 2026-10-03)

- Firma Ed25519 correcta (`license.ts`); el HQ emite la licencia de 30 días a una sucursal con su llave (`GET /api/hq/license`, `routes/hq.ts`).
- La clave pública con la que el local verifica **sale del HQ cuya URL teclea el usuario** y se guarda en la base (`hq_public_key`, `routes/cloud.ts`): quien monte su HQ firma sus licencias.
- Sin licencia o sin clave, `getLicense` devuelve `null` = **sin límites** (`license.ts`).
- La clave privada del HQ se genera y vive en la base del propio HQ (`hq_private_key`).
- El HQ entrega la llave de sucursal (`api_key`) al crear la sucursal; viaja por humanos.
- No hay identificación del equipo en la licencia.
- Las pruebas (376) asumen «sin licencia = sin límites»: ese comportamiento sigue existiendo como modo `open` para desarrollo, pruebas y demos.

## 2. Decisiones

**D3.1 — Dos modos de licencia: `open` (desarrollo, pruebas, demos) y `enforced` (paquete de producción).** En `enforced` se hornea en el ejecutable al construir (esbuild `define`) y **no se puede cambiar con una variable de entorno**; el paquete de producción exige haberse construido con una clave pública, o la construcción falla. Descartado: una variable de entorno que apague la licencia (trivial de saltarse editando el servicio).

**D3.2 — La clave pública va incrustada en el ejecutable** (lista de claves para poder rotar, con `kid`), nunca en la base ni descargada de un servidor que teclea el usuario. La clave privada solo existe en el HQ, como secreto de entorno (`HQ_SIGNING_KEY`, Railway Variables); la generada en la base queda solo para desarrollo, con un aviso en el registro. Un CLI (`keygen`) crea el par fuera del repo y deja la privada con permisos `600`.

**D3.3 — La licencia queda atada al equipo.** El payload lleva `fp`, una huella `sha256("nodo:v1:" + id de máquina)` (MachineGuid en Windows, IOPlatformUUID en macOS, `/etc/machine-id` en Linux). Nunca viaja el identificador crudo. Si la huella no coincide, el local pasa a modo restringido. Cambiar de equipo exige un código nuevo emitido por Nodo. Limitación conocida: una máquina virtual clonada o un Windows reinstalado cambian la huella (se resuelve con un código nuevo).

**D3.4 — Activación por código de un solo uso.** El propietario (o la plataforma) crea la sucursal en el HQ y emite un código `NODO-XXXX-XXXX-XXXX` (60 bits, se guarda su hash, vence a los 7 días, un código nuevo anula el anterior sin usar). En el local, *Configuración → Nube y plan → Activar* canjea el código **una vez con Internet**: el HQ registra la huella, **rota la llave de la sucursal** (la llave nunca pasa por manos humanas) y devuelve la llave y la licencia firmada. Desde ahí el local opera sin red. Descartado: teclear URL y llave (dos datos largos que se copian mal y que exponen la llave).

**D3.5 — Restringido, nunca bloqueado.** Sin licencia, con firma inválida, de otro equipo o vencida más allá de la gracia (7 días), el local queda con los límites y funciones del plan `gratis`; **sigue vendiendo** (I3). En modo `open` todo sigue como hoy.

**D3.6 — Retroceso de reloj.** Se guarda la marca de tiempo más alta vista (`license_clock_hwm`) y el vencimiento se evalúa con el máximo entre la hora actual y esa marca. Quien edite la base puede borrarla; es un freno barato, no una barrera.

**D3.7 — Sin ofuscación por ahora.** Un paquete de Node se puede leer; ofuscarlo encarece pero no impide. Se deja anotado como endurecimiento opcional si el piloto muestra un problema real. Lo valioso (respaldo y restauración en nube, actualizaciones, timbrado, soporte, consola) vive en el servidor de Nodo.

## 3. Invariantes

- **I3.1.** Ningún estado de licencia detiene la venta de un local.
- **I3.2.** La clave privada de firma no está en el repositorio, ni en la base de un local, ni en registros.
- **I3.3.** El paquete `enforced` ignora cualquier variable de entorno que intente cambiar el modo o las claves.
- **I3.4.** En modo `open` el comportamiento y las 376 pruebas existentes no cambian.
- **I3.5.** El identificador crudo de la máquina no sale del equipo.

## 4. Orden

- [ ] **F3.1 — Núcleo en el local:** huella del equipo, contexto de licencia (modos, claves incrustadas, estado y motivo), reloj, CLI `keygen`.
- [ ] **F3.2 — HQ:** columnas y tablas de activación, emisión y canje de códigos, rotación de llave, licencia con huella, clave de firma por entorno.
- [ ] **F3.3 — Local:** canje (`/api/license/activate`), sincronización con la huella y las claves incrustadas, estado enriquecido.
- [ ] **F3.4 — Pantalla:** estado de licencia, huella, activación por código.
- [ ] **F3.5 — Empaquetado:** `--license`, `--license-public-key`, `--hq-url`; el paquete de producción falla sin clave.
- [ ] **F3.6 — Documentación y cierre.**

## 5. Decidido con el dueño

`PLAN-00` §5 y §2 (D13): licencia atada al equipo; nube en Railway; modelo comercial sin definir (queda abierto: la licencia soporta suscripción y pago único).

## 6. Registro

*(se rellena al cerrar cada fase)*
