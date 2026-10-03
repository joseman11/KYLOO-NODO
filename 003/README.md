# Nodo — Comandero LAN-first (proyecto 003)

Servidor local (Node + SQLite) + PWA para tablets, pantallas táctiles, caja y KDS. Funciona sin Internet: todo viaja por la red local (WiFi o Ethernet) y las impresoras térmicas se alcanzan por TCP 9100 desde el servidor.

## Arranque
```bash
pnpm install
pnpm --filter @003/web build          # compila la PWA
pnpm --filter @003/server seed        # datos de ejemplo (admin / ADMIN_PASSWORD o admin1234; meseros PIN 1111, 2222; caja 3333)
pnpm --filter @003/server start       # http://<ip-del-servidor>:3003
```
Las tablets abren `http://<ip-del-servidor>:3003`. Variables: `PORT`, `HOST`, `DB_FILE`, `BACKUP_DIR`, `WEB_DIR`.

## Pruebas
`pnpm test` · `pnpm typecheck`

Documentación del proyecto (planes, estado, diseño): [`../docs/`](../docs/README.md).

## Instalar en el equipo del local (Windows)
Con una IP fija para el equipo, en PowerShell como Administrador:
```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-windows-service.ps1
```
Crea la tarea `003-comandas` (arranca con Windows y se reinicia sola) y abre el puerto en la red privada.

## Fase 2 (resumen)
Inventario y recetas (descuento al enviar la comanda), proveedores y compras, descuentos con autorización y promociones (2x1, happy hour…), clientes, reservaciones, pedidos para llevar y delivery, "listos para entregar" y menú QR por mesa. Detalle y decisiones en `../docs/PLAN-FASE2.md`.

Al actualizar, la base se migra sola al arrancar el servidor (migración 3). Conviene hacer un backup antes: Administración → "Backup ahora".

## Fase 3 (resumen)
Analítica avanzada, integraciones (pedidos por API + webhooks firmados), sincronización offline por lotes, facturación electrónica con proveedor de timbrado conectable, nube HQ multi-organización y planes con licencia firmada. Decisiones y límites en `../docs/PLAN-FASE3.md`.

**Facturación:** sin un proveedor de timbrado (PAC) conectado, las facturas se generan con el proveedor de prueba: CFDI 4.0 sin timbre, marcado "PRUEBA — sin validez fiscal". Para facturar de verdad hay que implementar la interfaz `InvoiceProvider` (`apps/server/src/routes/invoices.ts`) con las credenciales de un PAC y pasarla a `buildApp({ invoiceProvider })`.

**Servidor HQ (nube):**
```bash
ROLE=hq HQ_ADMIN_TOKEN=<secreto> PORT=3004 DB_FILE=data/hq.sqlite pnpm --filter @003/server start
```
Consola en `/hq`. La plataforma crea organizaciones con `POST /api/hq/orgs` (encabezado `x-hq-admin`); cada organización crea sucursales y obtiene su llave. En la sucursal: Configuración → Nube y plan → Vincular. Sin licencia instalada no hay límites (instalación propia).

## Menú, áreas y tickets
- **Áreas y destino:** Configuración → Áreas. Crea áreas (Cocina, Barra, Terraza…), sus estaciones y elige qué productos se preparan en cada una. Una comanda con refresco, taco y mojito se divide sola: bebidas a Barra, taco a Cocina.
- **Categorías propias:** Configuración → Categorías. Categorías y subcategorías (Tacos › Tacos de calamar), cada una con su destino; los productos nuevos lo heredan.
- **Separadores:** en la comanda, el botón *Separador* agrega "Entradas", "Plato fuerte", "Postre" o un nombre propio; cocina y barra lo imprimen en ese orden. En Configuración → Tickets eliges la línea separadora, agrupar la cuenta por categoría y el texto al pie, con vista previa.

## Comandero avanzado
- **Fotos de platillos:** Configuración → Productos → Editar/Nuevo → "Tomar foto" o "Elegir de la galería". La foto se reduce en el dispositivo (~100 KB) y se guarda en `data/photos` (variable `PHOTOS_DIR`); incluye esa carpeta en tus respaldos. Se ve en el comandero (botón *Fotos* para ocultarlas) y en el menú QR.
- **Comandero estilo punto de venta clásico:** menú lateral de módulos, cuenta con Cant./Descripción/Importe y renglón seleccionable, cantidad por producto (×1…×5 o teclado), asiento, buscador, favoritos (los más pedidos de cada mesero, o clic derecho para fijar), categorías en columna con subcategorías y barra de funciones.
- **Mapa de mesas:** al elegir una mesa libre se captura el número de personas con teclado; en una ocupada se ve mesero, comensales, tiempo, última comanda y consumo promedio por persona.
- **Tiempos retenidos (hold & fire):** en *Separador* activa "Retener"; ese tiempo no sale a cocina hasta *Mandar tiempo* (en la cuenta o en *Pase*). Al mandarlo, cocina y barra reciben la comanda con el título "SALE".
- **Pase:** todas las mesas con producción, qué estación ya terminó, "Todo listo" y *Entregar*; permite devolver un ticket a cocina.
- **Cobro:** cuenta completa, en partes iguales o por asiento (cada pago cubre una parte y la cuenta se cierra al saldarse); tarjetas de regalo como método de pago.
- **Cargo por servicio** (Configuración → Ajustes → Cobro): porcentaje y desde cuántas personas; se factura como concepto aparte y un gerente puede dispensarlo.
- **Checador y propinas:** botón de entrada/salida en la barra superior; Admin → Personal y propinas muestra horas y el reparto (cada mesero conserva lo suyo con aporte a apoyo, o fondo común por rol y horas).
- **Tarjetas de regalo:** se venden en Caja (código impreso); Admin → Tarjetas de regalo muestra vendidas, canjeadas y saldo pendiente.
