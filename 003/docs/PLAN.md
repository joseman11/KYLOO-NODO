# 003 — Comandero LAN-first (MVP Fase 1)

## Context
Idea 001 describe un POS/comandero para restaurantes. Decisión clave del usuario: debe operar **por red local (Ethernet, WiFi o LAN) sin depender de Internet**. Por eso 003 se diseña *local-first*: un servidor en una PC/mini-PC del local es la fuente de verdad; tablets, pantallas táctiles y caja son clientes web en la misma red; las impresoras térmicas se alcanzan por TCP/IP desde ese servidor. La nube (multi-sucursal, SaaS, facturación) queda para Fase 3 sin cambiar el modelo.
Directorio actual: vacío salvo `DESIGN (2).md` (referencia visual). Proyecto nuevo, sin git.

## Arquitectura (recomendada)
```text
Tablet mesero / Pantalla táctil / POS caja / KDS   (navegador, PWA)
        │  HTTP + WebSocket (WiFi o Ethernet)
        ▼
Servidor local 003  (Node + TypeScript, Fastify)  ← PC Windows del local
   ├─ SQLite (WAL)  — datos, un solo archivo, backup = copiar archivo
   ├─ Motor de enrutamiento de producción
   ├─ Cola de impresión (reintentos + impresora secundaria)
   └─ Eventos en tiempo real (WebSocket)
        │  TCP 9100 (ESC/POS)  /  USB local
        ▼
Impresoras térmicas cocina / bar / caja
```
Por qué: un solo servidor local elimina el servicio de impresión aparte (el servidor ya está en la LAN), funciona igual con cable o WiFi, y no hay nada instalado en las tablets. SQLite es suficiente para un local (decenas de dispositivos) y migra a PostgreSQL vía Drizzle cuando llegue multi-sucursal.

**Stack:** pnpm monorepo · TypeScript · Fastify + `ws` · Drizzle ORM + better-sqlite3 · Zod (validación compartida) · React + Vite (PWA) · `node-thermal-printer` (ESC/POS) · Vitest.

## Estructura
```text
003/
├─ apps/
│  ├─ server/      API REST + WS, auth, motor de rutas, cola de impresión, backups
│  └─ web/         PWA única con vistas por rol: mesero, caja, KDS/estación, admin
├─ packages/
│  ├─ shared/      tipos, esquemas Zod, máquina de estados de comanda, permisos
│  └─ ui/          tokens + componentes (según DESIGN.md)
└─ docs/DESIGN.md  sistema visual de 003
```

## Dominio y módulos MVP (Fase 1, los 20 puntos)
1. **Auth/usuarios/roles/permisos** — login por PIN (mesero) y usuario+contraseña (admin); permisos granulares (sec. 5); hash argon2; JWT corto + refresh; bloqueo por inactividad.
2. **Estructura del local** — mesas, zonas, áreas → subáreas → estaciones (sec. 3, 6).
3. **Catálogo** — categorías, productos, modificadores (obligatorio/múltiple/límite/precio), ruta de producción por producto (área/subárea/estación/impresora).
4. **Comandas** — máquina de estados `borrador→enviada→recibida→en_preparación→preparada→entregada` + `cancelada/rechazada/devuelta`; transiciones validadas por permiso (sec. 69); adiciones como comanda hija (sec. 15); concurrencia por versión optimista en mesa (sec. 68).
5. **Motor de enrutamiento** (núcleo, sec. 12/88) — al enviar, agrupa ítems por estación → crea `production_tickets` → encola impresión/KDS; registra tiempos de envío/inicio/listo/entrega. Función pura y testeable en `shared`.
6. **Impresoras** — CRUD, probar impresión, principal/secundaria, ancho 58/80 mm, copias, corte; estado por ping TCP; alerta de caída.
7. **Cola de impresión** — tabla `print_jobs` persistente (estado pendiente/error/impreso), reintento con backoff, failover a secundaria, "imprimir manualmente"; nunca se pierde una comanda (RN-012).
8. **Caja/pagos/cortes** — apertura con fondo, pagos mixtos idempotentes (clave de idempotencia, RN-010), propinas, retiros/ingresos, corte parcial/final con diferencia y motivo.
9. **Mesas operativas** — abrir, transferir mesero, cambiar mesa, fusionar, dividir cuenta (HU-007..010).
10. **Auditoría** — bitácora append-only de toda operación sensible (sec. 54).
11. **Reportes básicos + dashboard** — ventas por día/hora/mesero/producto/método de pago; export CSV.
12. **Dispositivos y tiempo real** — registro de dispositivos, presencia, broadcast de cambios de mesa/comanda.

## Red local (detalles críticos)
- Servidor con **IP fija** y anuncio **mDNS** (`003.local`); las tablets abren esa URL o un QR.
- **HTTPS en LAN**: las PWA/service worker exigen contexto seguro; se genera una CA local (mkcert-style) y se instala una vez en cada tablet. Alternativa documentada: HTTP simple sin instalación offline.
- Reconexión automática del WebSocket + cola local en cliente para pedidos si el WiFi parpadea (modo offline-lite de sec. 67); al reconectar se sincroniza con ids generados en cliente (UUID) para evitar duplicados.
- Servidor instalado como **servicio de Windows** (node-windows/NSSM) con arranque automático; backup diario automático del archivo SQLite + manual desde admin.
- Impresoras en IP fija, puerto 9100; USB soportado solo en la máquina servidor.

## UI / diseño (estilo `DESIGN (2).md`)
Se crea `docs/DESIGN.md` para 003 adaptando el sistema Brex: lienzo Paper `#fff`, secciones Fog `#f3f3f7`, bordes Mist 1 px, texto Ink/Graphite, **un solo acento Ember `#ff5900`** (acción primaria por región), Inter con tracking negativo, radios 12 px (tags 6 px), sin sombras salvo modales, escala de 8 px.
Adaptaciones táctiles: objetivos mínimos **48 px** (botones de mesero 56 px), tipografía base 16 px, modo oscuro Carbon/Abyss solo para KDS de cocina. Estados de mesa sin segundo acento: usar Ember solo para "requiere acción" y diferenciar el resto con iconos + escala de grises. Prioridad: velocidad → claridad → confiabilidad → control → analítica (sec. 87).

## Orden de construcción
1. Monorepo, `shared` (esquemas, máquina de estados, permisos), `docs/DESIGN.md`, tokens UI.
2. Server: DB + migraciones, auth/PIN, estructura del local, catálogo.
3. Comandas + motor de enrutamiento + tests unitarios.
4. Impresión: cliente ESC/POS, cola, failover, prueba de impresión.
5. WebSocket y vistas: mapa de mesas → toma de pedido (tablet) → estación/KDS.
6. Caja: pagos idempotentes, cortes, retiros.
7. Auditoría, reportes, dashboard, backups, instalador de servicio.

## Verificación
- `vitest`: enrutamiento (ejemplo sec. 12: 1 hamburguesa+1 ensalada+2 margaritas → 3 tickets), transiciones de estado, adición imprime solo delta, pago idempotente, diferencia de caja.
- Impresión: simulador TCP 9100 en tests; prueba real con impresora térmica; apagar impresora principal → verifica reintento y failover.
- Integración LAN: servidor + 2 tablets/navegadores en WiFi y 1 por cable; abrir misma mesa en ambos → el segundo es rechazado; cortar WiFi y reconectar → sin duplicados.
- Cierre de día: abrir caja, vender con pago mixto, corte final cuadra con reporte; auditoría registra cada paso.

## Fuera de alcance de este plan
Inventario/recetas, KDS avanzado, delivery, QR, facturación, multi-sucursal/SaaS (Fases 2–3).
