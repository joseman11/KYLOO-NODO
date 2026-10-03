# Red local, impresoras, cajón y trabajo sin conexión

> Vigente al 2026-10-03 (plan 05). Diseño y razones: [`PLAN-05`](../PLAN-05-IMPRESION-Y-RED-LOCAL.md). **Probado con simulaciones** (impresora y cajón simulados, Chrome automatizado, mDNS en macOS); **sin probar con impresoras, cajones ni tablets físicos** (ver «Qué falta»).

## La red del local

- Una **PC con Nodo** y las tablets, la caja, la cocina y las impresoras en la **misma red** (WiFi o cable). Nodo no necesita Internet para vender.
- Asigna **IP fija** a la PC (en el router, reservándole la dirección, o en Windows). Las impresoras también con IP fija: Nodo las encuentra por IP.
- Windows: el instalador abre el puerto 3003 solo a la red local (`RemoteAddress = LocalSubnet`).

## Conectar una tablet o un teléfono

*Configuración → Conectar*: muestra el **código QR** y la dirección por cada IP del equipo (`http://192.168.1.20:3003`). Se escanea con la cámara o se escribe en el navegador. También se anuncia el nombre **`nodo.local`** (mDNS/Bonjour): funciona en iOS, macOS y Windows con Bonjour; **no todas las versiones de Android lo resuelven**, por eso la IP y el QR son el camino seguro. Verificado: `ping nodo.local` y `dns-sd -B _http._tcp` ven el servicio en macOS.

## Impresoras de red (Ethernet o WiFi, puerto 9100)

1. Conecta la impresora a la red y ponle IP fija (casi todas imprimen una hoja de configuración con su IP al encenderlas con el botón *Feed* pulsado).
2. *Configuración → Impresoras → **Buscar en la red***: prueba el puerto 9100 en las redes /24 de la PC (≈ 254 direcciones por red, unos segundos) y muestra lo que encuentra. **Agregar** da de alta con nombre y tipo (cocina, bar, caja…). Las ya agregadas aparecen marcadas.
3. **Probar** imprime una hoja de prueba y dice si la impresora respondió.
4. Cada estación (cocina, barra…) tiene una impresora principal y una de respaldo (*Configuración → Impresoras*, sección de estaciones). Si la principal no responde, el trabajo pasa a la de respaldo; si ninguna responde, **queda en cola y se reintenta** (nunca se pierde).

## Cajón de dinero

- Se conecta a la **impresora de caja** con el cable RJ11 de la propia impresora (así se hace con casi todos los cajones de monedero).
- *Configuración → Impresoras*: en la impresora de caja, **«Cajón: no» → «Cajón: sí»**.
- Se abre solo con cada **cobro que incluye efectivo** (el pulso va al inicio del mismo trabajo del ticket, por la misma cola: si la impresora no responde, el cobro ya quedó registrado y el cajón y el ticket salen cuando vuelva).
- *Caja → **Abrir cajón*** lo abre a mano (dar cambio, retiro) y queda en la bitácora.
- Pin del cajón: por defecto el pin 2 (lo habitual); el pin 5 se puede cambiar por la API (`drawer_pin: 1`) mientras no tenga botón en pantalla.

## Qué pasa si una tablet pierde la red a mitad de una comanda

| Situación | Resultado |
|---|---|
| Cae **Internet** | Nada: todo es red local. |
| La tablet pierde el WiFi con una mesa abierta | Sigue pidiendo y pidiendo la cuenta; la comanda se guarda en la tablet y se envía sola al volver (ver el aviso «Sin conexión: comanda guardada»). |
| La tablet pierde el WiFi y **abre una mesa libre** | Se abre «en sombra»: la mesa se ve ocupada («sin sincronizar»), se puede pedir, y al volver la red se abre de verdad y las comandas se aplican a esa cuenta, **en orden y una sola vez** (cada operación lleva un identificador). |
| Otra tablet ocupó esa mesa mientras tanto | Al sincronizar, la tablet avisa «No se pudo abrir la mesa T5 que abriste sin conexión» y vuelve al mapa; no se duplica nada. |
| Cobros, descuentos, cancelaciones sin conexión | **No**: necesitan al servidor (la caja está en la red local, no en la tablet). La pantalla lo dice. |
| La tablet apaga o recarga la página | Lo pendiente **no se pierde** (queda en el almacenamiento del dispositivo). |

El menú se guarda en la tablet al entrar y cada vez que vuelve la conexión.

## Qué falta (honesto)

- 🔴 **Probar con equipo real:** una impresora térmica de red, un cajón de monedero y una tablet barata (rendimiento a pocos cuadros por segundo, táctil, WiFi que parpadea).
- ✅ **Recargar sin red:** resuelto con la **app de tablet** (`APP-TABLET.md`): la interfaz va dentro de la app y abre siempre. En un navegador normal sobre `http://` sigue sin poder recargarse sin red.
- 🟠 **Servidor caído:** hay reinicio automático (servicio de Windows), pero no hay servidor de reserva ni aviso en pantalla de «servidor caído» más allá del indicador de conexión (D12).
- 🟡 Pin 5 del cajón y «copias» por impresora no tienen pantalla; el escaneo solo recorre redes /24.
- 🟡 La cola del cliente usa `localStorage` (≈ 5 MB): sobra para una noche de comandas, pero un día entero sin red con cientos de operaciones merece IndexedDB.
