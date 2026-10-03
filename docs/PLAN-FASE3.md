# 003 — Fase 3

> **Etapa cerrada** (código en `main`). 📍 Plan histórico, anterior al método de trabajo (`PLAN-00`). El estado real está en [`ESTADO-ACTUAL.md`](ESTADO-ACTUAL.md), que gana si discrepan.

Sigue siendo local-first: cada sucursal opera con su propio servidor aunque no haya Internet. La nube (HQ) solo agrega, distribuye catálogo y licencia; si se cae, las sucursales siguen vendiendo.

## Decisiones
| Módulo | Decisión |
|---|---|
| **Analítica** | Endpoints y pantalla: ventas por hora y día, ticket promedio, productos por comanda, rotación de mesas, tiempos de preparación por estación, cancelaciones y mermas, análisis ABC de productos, comparativo contra el periodo anterior y pronóstico simple por día de semana y hora. |
| **Integraciones** | Pedidos externos (web, WhatsApp, apps de delivery) por API con llave por integración; los productos se identifican por SKU; idempotentes por referencia externa. Webhooks salientes firmados (HMAC) con cola de reintentos. |
| **Offline avanzado** | Endpoint de sincronización por lotes: abrir mesa, comanda y pedir cuenta con id de operación idempotente y resultado por operación (ok, duplicada, conflicto). El cliente guarda cualquiera de esas operaciones sin red. |
| **Facturación** | Datos fiscales del cliente, solicitud y emisión por cuenta pagada, cancelación con motivo, reenvío y descarga de XML. Un proveedor de timbrado (PAC) se conecta mediante una interfaz; sin credenciales de PAC solo existe el proveedor **de prueba**, que genera un CFDI 4.0 sin timbre y lo marca "PRUEBA — sin validez fiscal". No se inventan UUID fiscales. |
| **Multi-sucursal y multi-tenant** | Modo `HQ` del mismo servidor: organizaciones, sucursales con llave propia, ventas diarias consolidadas, catálogo maestro que cada sucursal descarga (las rutas de producción se resuelven por nombre de estación). Los datos de cada organización están aislados. |
| **SaaS** | Planes con límites (sucursales, usuarios, impresoras) y funciones. HQ firma la licencia (Ed25519); la sucursal la verifica y aplica límites. Sin licencia instalada no hay límites (instalación propia). |

## Orden
1. Migración 4 y analítica.
2. Integraciones y webhooks.
3. Sincronización por lotes (offline).
4. Facturación.
5. HQ, multi-tenant y licencias.
6. Pantallas (sin scroll, estilo SoftRestaurant) y pruebas.

## Fuera de alcance
Multi-idioma y multi-moneda; timbrado real con un PAC (requiere contrato y credenciales); conciliación con plataformas de delivery específicas (cada una necesita su propio conector).
