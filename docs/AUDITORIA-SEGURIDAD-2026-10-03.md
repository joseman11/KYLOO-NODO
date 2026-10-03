# Auditoría de seguridad — 2026-10-03

> **Etapa cerrada** (2026-10-03, rama `feature/fundacion`). Resuelve D9 de [`PLAN-00`](PLAN-00-ESTRUCTURA-DE-TRABAJO.md) en lo que se puede hacer sin un piloto real. **Es una auditoría estática y con pruebas automáticas**; no sustituye una prueba de penetración externa antes de vender.

## 1. Qué se audita y por qué

Un sistema que guarda ventas, personal y datos de clientes de un restaurante, que corre en la red local de un local (poco vigilada) y que tendrá un servidor en la nube. Se revisó: acceso y sesiones, errores, cabeceras, validación de entradas, SQL, archivos subidos, licencias, respaldos, el servidor HQ y las dependencias.

## 2. Método

Lectura de las rutas del servidor, `grep` de patrones de riesgo (SQL con interpolación, comparaciones de secretos, rutas de archivos), `pnpm audit` y `npm audit`, y **una prueba automática por cada arreglo**. **No se pudo comprobar:** el comportamiento con una red real hostil, la fuerza bruta contra el hardware lento de un local, ni el endurecimiento del sistema operativo del equipo.

Escala: ✅ Confirmado y cerrado · 🟡 Aceptado o por decidir con el dueño · 🟠/🔴 gravedad.

## 3. Hallazgos

### Cerrados en esta etapa

#### 🔴 S1 — Dependencia con fallos críticos en la verificación de sesiones — ✅
- **Evidencia:** `pnpm audit --prod`: 7 avisos (3 críticos, 2 altos) en `fast-jwt` (vía `@fastify/jwt`): evasión de autenticación por clave HMAC vacía, confusión de algoritmo, validación de `iss`, y `ansi-regex` (vía `qrcode`).
- **Arreglo:** `@fastify/jwt` 10.2.2 (trae `fast-jwt` 6.3.3) y un `override` de `ansi-regex`. **Resultado: «No known vulnerabilities found»**; las 469 pruebas siguen en verde.
- **Landing:** `npm audit` mostraba `next`/`postcss` (alto); se fijó `postcss ≥ 8.5.23` con `overrides` y el audit queda en 0 (compila igual).

#### 🟠 S2 — Un error del servidor devolvía su texto interno — ✅
- **Reproducción:** una excepción con mensaje `SQLITE_ERROR … /var/lib/nodo/…` llegaba tal cual al cliente.
- **Arreglo:** los 5xx responden `{ error: "error_interno", id }`; el texto va solo al registro (con el mismo `id`). Los errores del usuario (400/404/409) siguen explicándose. Prueba: `endurecimiento.test.ts`.

#### 🟠 S3 — Sin cabeceras de seguridad — ✅
- **Arreglo:** `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` (cámara solo propia, para las fotos) y **política de contenido** (sin scripts de fuera, sin marcos, sin `eval`). Se verificó con las e2e que la app no genera ninguna violación (las pruebas fallan con cualquier error de consola).

#### 🟠 S4 — Sin límite de intentos de acceso por IP — ✅
- **Antes:** solo el bloqueo por usuario (5 fallos → 60 s). Un mismo equipo podía probar PIN contra todas las personas.
- **Arreglo:** 120 intentos de acceso por IP cada 5 minutos (PIN, usuario/contraseña y HQ); respuesta `429` con `Retry-After`. Detrás del proxy de Railway usa la IP real (`trustProxy`) y sin proxy **no** se fía de `X-Forwarded-For`. Apagado en pruebas salvo configuración explícita.

#### 🟠 S5 — La configuración inicial estaba abierta a toda la red local — ✅
- **Reproducción:** en una instalación nueva, cualquier dispositivo de la red que llegara antes que el dueño podía crear al administrador.
- **Arreglo:** `POST /api/setup` solo desde el propio equipo (`localhost`); desde otro dispositivo responde 403 y la pantalla explica dónde configurar. `NODO_SETUP_REMOTE=1` lo permite para desarrollo/contenedores. Pruebas en `setup.test.ts`.

### Revisados y correctos

- ✅ **SQL:** todo con parámetros. Los `UPDATE` dinámicos (`crud.ts`, `catalog.ts`, `customers.ts`, `recipebook.ts`) toman los **nombres de columna del esquema** validado, no del cliente.
- ✅ **Fotos:** tipo real por bytes (JPG/PNG/WebP), tamaño máximo, nombre del archivo con expresión regular estricta (sin rutas).
- ✅ **QR de menú:** HMAC-SHA256 con comparación de tiempo constante.
- ✅ **Contraseñas y PIN:** scrypt con sal; token de la plataforma del HQ comparado en tiempo constante.
- ✅ **Licencias y respaldos:** ver `docs/deploy/LICENCIAS.md` y `RESPALDOS.md` (clave privada fuera del repo, cifrado de extremo a extremo con autenticación, retención y cuota).
- ✅ **Registros:** sin tokens (la URL del WebSocket se registra sin parámetros), sin contraseñas.

### Abiertos o por decidir

#### 🟠 S6 — El tráfico de la red local va sin cifrar (HTTP)
PIN y token de sesión viajan en claro dentro del local. Mitigación: la red es del dueño y no hay Internet de por medio, pero cualquier dispositivo conectado al mismo WiFi puede escuchar. **Solución:** HTTPS local (D11), junto con el service worker. Hasta entonces: red WiFi del servicio con contraseña y **separada de la de clientes**.

#### 🟡 S7 — `GET /api/auth/users` es público
Lista nombres, puestos y fotos para la pantalla de PIN (diseño). En una red de local es aceptable; si el servidor se expusiera a Internet habría que cerrarlo. **No exponer el puerto 3003 a Internet.**

#### 🟡 S8 — La sesión (JWT de 12 h) vive en `localStorage`
Un fallo de XSS la robaría; la política de contenido lo hace mucho menos probable y no hay HTML dinámico de usuarios sin escapar (React). Pasar a cookie `httpOnly` es un cambio de arquitectura: no se hace sin un motivo concreto.

#### 🟡 S9 — PIN de 4 dígitos
Con el bloqueo por usuario y el límite por IP, probar 10 000 combinaciones lleva días. Para gerente y supervisor conviene exigir **6 dígitos**: no se cambió para no alterar la operación sin hablarlo con el dueño.

#### 🟡 S10 — El bloqueo por usuario permite molestar
Cinco fallos bloquean a una persona 60 s: alguien puede dejar sin acceso a un mesero concreto. Aceptado (el límite por IP ayuda); alternativa: bloqueo por usuario+IP.

#### 🟡 S11 — Webhooks salientes a cualquier URL
Un administrador puede apuntar un webhook a una dirección interna (SSRF hacia la LAN). El administrador del local es de confianza; el HQ **no** ejecuta webhooks. Bajo.

#### 🟡 S12 — `api_key` de sucursal en claro al crearla y token único de plataforma
Compatibilidad: la activación ya no la necesita. Quitarla cuando se ordene el HQ; rotar `HQ_ADMIN_TOKEN` cuando alguien salga del equipo.

## 4. Decisiones que esta auditoría deja al dueño

1. ¿PIN de 6 dígitos para gerente/supervisor? (S9)
2. ¿Se compra una prueba de penetración externa antes del primer cliente? (recomendado)
3. HTTPS local (S6): se decide con la tablet real (D11).

## 5. Orden propuesto

HTTPS local (S6) → PIN de 6 dígitos (S9) → retirar `api_key` en claro (S12) → prueba de penetración externa.

## 6. Registro

- **2026-10-03** — S1 a S5 cerrados (commit de cierre de esta auditoría). 9 pruebas nuevas de endurecimiento, 2 de configuración inicial local, `pnpm audit` y `npm audit` en cero. Suite completa en verde.
