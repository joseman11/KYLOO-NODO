# 003 — Fase 2

> **Etapa cerrada** (código en `main`). 📍 Plan histórico, anterior al método de trabajo (`PLAN-00`). El estado real está en [`ESTADO-ACTUAL.md`](ESTADO-ACTUAL.md), que gana si discrepan.

Mismo enfoque que la Fase 1: servidor local (Fastify + SQLite) y PWA, sin depender de Internet. Todo lo nuevo se suma sin romper el flujo de comandas: un producto sin receta no toca inventario, una cuenta sin descuento cobra igual.

## Alcance y decisiones
| Módulo | Decisión |
|---|---|
| **Inventario** | Insumos con unidad, stock, mínimo/máximo, costo promedio. Movimientos (entrada, salida, ajuste, merma, venta). Inventario físico genera ajustes. Alertas: stock bajo, agotado, negativo (evento en tiempo real). |
| **Recetas** | Producto → insumos con cantidad. Se descuenta al **enviar** la comanda; si el producto se cancela antes de producción se devuelve; si ya estaba en producción queda como consumo. Reporte de costo y margen por producto. |
| **Proveedores y compras** | CRUD de proveedores; órdenes de compra con recepción que suma stock y recalcula costo promedio ponderado. |
| **Promociones y descuentos** | Descuento manual (% o monto) con límite configurable (`discount_limit_pct`); sobre el límite pide PIN de gerente (RN-007). Promociones: porcentaje, monto, 2x1 y precio especial, por producto/categoría, con vigencia, días y horario (happy hour). Se aplican a la cuenta y quedan auditadas. |
| **Clientes** | Datos de contacto y fiscales, historial de consumo, vínculo con la cuenta. |
| **Reservaciones** | Crear, confirmar, "llegó", cancelar, "no se presentó"; sentar abre la cuenta en la mesa. |
| **Para llevar y delivery** | Cuentas sin mesa (`kind` mesa/llevar/delivery) con folio propio (L1, D1), datos de contacto, costo de envío, repartidor y estados. Usan el mismo motor de comandas, cocina y caja. Estado "listo" automático cuando producción termina. |
| **KDS** | La vista de estación de la Fase 1 se complementa con "Listos para entregar" en el mapa de mesas. |
| **Menú QR** | QR firmado por mesa → menú público sin login, pedir (solo si la mesa tiene cuenta abierta), llamar al mesero y pedir la cuenta. |

## Cambios de modelo (migración 3)
`accounts.table_id` pasa a ser opcional (reconstrucción de tabla con claves foráneas desactivadas, procedimiento oficial de SQLite), más `kind`, `label`, `customer_id`. Nuevas tablas: `customers`, `reservations`, `delivery_info`, `account_discounts`, `promotions`, `inventory_items`, `inventory_movements`, `recipe_lines`, `suppliers`, `purchase_orders`, `purchase_lines`; `orders.source`.

## Orden
1. Permisos, migración y total de cuenta con descuentos y envío.
2. Inventario, recetas, proveedores y compras (+ consumo al enviar).
3. Descuentos y promociones.
4. Clientes y reservaciones.
5. Para llevar / delivery y "listos para entregar".
6. Menú QR público.
7. Pantallas web y pruebas.

## Verificación
Tests de servidor por módulo (descuento de inventario al enviar y reversa al cancelar, costo promedio en recepción, límite de descuento con autorización, 2x1 y happy hour, cuenta de delivery cobrada con envío, QR firmado). Recorrido en navegador de las pantallas nuevas.

## Fuera de alcance (Fase 3)
Facturación CFDI, multi-sucursal/SaaS, integraciones externas, predicción de demanda, combos con componentes propios.
