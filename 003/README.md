# Nodo — Comandero LAN-first (proyecto 003)

Servidor local (Node + SQLite) + PWA para tablets, pantallas táctiles, caja y KDS. Funciona sin Internet: todo viaja por la red local (WiFi o Ethernet) y las impresoras térmicas se alcanzan por TCP 9100 desde el servidor.

## Arranque (desarrollo)
```bash
pnpm install                          # Node 24 o superior; pnpm 11.21 (ver ../CLAUDE.md)
pnpm --filter @003/web build          # compila la PWA
pnpm --filter @003/server start       # http://<ip-del-servidor>:3003 — sin base, abre el asistente de primer arranque
pnpm --filter @003/server seed        # solo desarrollo: datos de ejemplo (admin / ADMIN_PASSWORD o admin1234; PIN 1111, 2222, 3333)
pnpm --filter @003/server seed:demo   # solo desarrollo y demos: marisquería de ejemplo
```
Las tablets abren `http://<ip-del-servidor>:3003`. Variables: `NODO_DATA_DIR` (carpeta de datos: base, fotos, respaldos y registros), `PORT`, `HOST`, `NODO_LOG_LEVEL`, y las rutas sueltas `DB_FILE`, `BACKUP_DIR`, `PHOTOS_DIR`, `LOG_DIR`, `WEB_DIR`.

## Pruebas
`pnpm test` · `pnpm typecheck`

Documentación del proyecto (planes, estado, diseño): [`../docs/`](../docs/README.md).

## Instalar en el equipo del local
Se instala con un paquete sin herramientas de desarrollo: `Nodo-Setup-<versión>.exe` en Windows (servicio que arranca con el equipo y se reinicia solo). Procedimiento, actualización, desinstalación y cómo construir el paquete: [`../docs/deploy/INSTALACION.md`](../docs/deploy/INSTALACION.md). Una instalación nueva no trae usuarios ni claves: el asistente de primer arranque crea al administrador.

## Fase 2 (resumen)
Inventario y recetas (descuento al enviar la comanda), proveedores y compras, descuentos con autorización y promociones (2x1, happy hour…), clientes, reservaciones, pedidos para llevar y delivery, "listos para entregar" y menú QR por mesa. Detalle y decisiones en `../docs/PLAN-FASE2.md`.

Al actualizar, la base se migra sola al arrancar el servidor y, antes de migrar, se copia a `backups/pre-migracion-…sqlite`.

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
