# Plan 07 — Servidor de reserva

> **Etapa cerrada** (2026-10-03, rama `feature/fundacion`). Cierra la parte (c) de D12 de [`PLAN-00`](PLAN-00-ESTRUCTURA-DE-TRABAJO.md): «se cae el servidor del local». Guía de uso: [`deploy/RESERVA.md`](deploy/RESERVA.md).
>
> 🤖 Sesión autónoma: las decisiones de abajo las tomó la sesión y quedan en el Registro para que el dueño las revise.

## 0. El encargo
> «Servidor de reserva (otra PC del local en espera con réplica continua) como componente del diseño, no como extra opcional. Se decide en F5 cómo se promueve (manual con un botón, o automático).» (D12c)

## 1. Decisiones
- **D7.1 — Promoción manual, con botón y con la clave.** Automática arriesga *split brain* (dos servidores con datos distintos si solo se cortó la red). Un humano mira que el principal de verdad esté caído; si el principal contesta, se pide confirmación extra.
- **D7.2 — Copia por instantánea cada 5 min, no réplica continua.** Reutiliza el paquete de respaldos (base + fotos, `NODOPK1`) y su cifrado; es sencillo de probar y no toca el camino de venta. Costo asumido: se puede perder lo de los últimos minutos. La réplica por eventos queda como mejora.
- **D7.3 — Emparejamiento por una clave de 256 bits** (mismo formato de 55 símbolos que la de recuperación). De ella salen por HKDF **dos** valores: el token con que la reserva se identifica (viaja) y la clave de cifrado de la copia (no viaja). El principal compara el token en tiempo constante.
- **D7.4 — La reserva no atiende comandas:** arranca un servidor mínimo (estado + promover) y, al promoverse, **el mismo proceso** sigue arrancando como principal (`main.ts` espera con `await`; no hay reinicio de servicio).
- **D7.5 — La copia buena nunca se pisa con una dañada:** se descarga, se descifra y verifica en una carpeta aparte y solo entonces reemplaza.
- **D7.6 — Tablets (app):** aprenden la reserva de `/api/standby/peers` y, si el servidor no contesta 6 s, sondean `/api/health` de la lista y se pasan al que sea `primary`. Los navegadores no pueden sondear otro origen (CORS/CSP): usan `nodo.local`.
- **D7.7 — La licencia no se copia a la reserva:** está atada al equipo; la reserva promovida corre en plan gratuito hasta activarse con un código nuevo (consistente con el plan 03).

## 2. Invariantes
- **I7.1.** La copia sale cifrada; sin la clave de emparejamiento no se descarga ni se lee.
- **I7.2.** Una copia a medias o dañada nunca reemplaza la última buena.
- **I7.3.** Promover no ocurre por accidente: exige la clave y, si el principal contesta, una confirmación expresa.
- **I7.4.** Nada de esto estorba la venta del principal (la copia se hace con la API de respaldo, sin pararlo).

## 3. Orden
- [x] **F7.1 — Núcleo** (`standby.ts`): claves, token, copia verificada, instalación de la copia, estado.
- [x] **F7.2 — Principal:** `/api/standby/{pairing,status,peers,snapshot}`.
- [x] **F7.3 — Reserva:** servidor mínimo con página de estado y promoción; CLI `server.mjs standby`; arranque y paso a principal en `main.ts`.
- [x] **F7.4 — Tablets:** lista de servidores, sondeo, cambio automático y avisos; tarjeta en *Configuración → Conectar*.
- [x] **F7.5 — Pruebas:** 7 de servidor, 3 e2e (decisión de cambio y página de la reserva en Chrome) y una corrida con **dos procesos reales**.
- [x] **F7.6 — Cierre.**

## 4. Registro
- **2026-10-03** — Etapa completa. Probado con dos procesos reales: la reserva copió 688 KB del principal, el principal se mató, la reserva conservó su última copia buena, se promovió y respondió como `role: primary` con el mismo acceso. Salió de paso: `primary_up` se calculaba solo en cada copia (5 min): la página mostraba un estado viejo; ahora se consulta al pedir `/api/health` (memoria de 3 s).

### Pendiente
- 🟠 Réplica continua por eventos (para pérdida casi cero) y devolver el rol de principal sin reemparejar a mano.
- 🟠 Probar la promoción en dos equipos físicos y el cambio de servidor de la app en una tablet real.
- 🟡 Aviso en el principal cuando la reserva lleva mucho sin copiar (hoy se ve en rojo en la tarjeta, sin notificación).
