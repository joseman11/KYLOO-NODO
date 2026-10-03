# Licencias: cómo se emiten, se activan y se protegen

> Vigente al 2026-10-03 (plan 03). Diseño y razones: [`PLAN-03`](../PLAN-03-LICENCIAS-Y-ACTIVACION.md). **Modelo comercial: suscripción anual** (decidido por el dueño el 2026-10-03).

## Idea en cuatro líneas

1. Nodo firma licencias con una clave **privada** que solo existe en el servidor de Nodo (HQ).
2. El programa instalado lleva incrustada la clave **pública**; ninguna variable de entorno ni dato de la base la cambia.
3. La licencia va **atada al equipo** (huella del identificador de la máquina) y vence.
4. Sin licencia válida el local pasa al plan gratuito: **nunca se detiene la venta**.

**Estado (2026-10-03):** el par de producción **ya existe**. La privada está en `~/.nodo-keys/license-private.pem` (Mac del dueño, permisos 600) y como `HQ_SIGNING_KEY` en el HQ; la pública está en el repo: [`003/licensing/license-public.pem`](../../003/licensing/license-public.pem). Un paquete de producción se construye con `--license-public-key 003/licensing/license-public.pem --hq-url https://nodo-hq-production.up.railway.app`.

## Una sola vez: crear las claves (ya hecho)

```bash
cd 003
npx -y pnpm@11.21.0 --filter @003/server keygen -- --out ~/.nodo-keys
```

Crea `license-private.pem` (permisos 600) y `license-public.pem`. Reglas:

- La **privada** va como variable secreta `HQ_SIGNING_KEY` del HQ (Railway → Variables; los saltos de línea pueden escribirse `\n`) y a una **copia de seguridad fuera de línea**. Si se pierde, hay que emitir un paquete nuevo con otra clave; si se filtra, cualquiera puede fabricar licencias. **Nunca** al repositorio, a la base de un local ni a los registros.
- La **pública** se puede guardar en el repositorio y se pasa al empaquetar.
- Para **rotar** claves, se empaqueta con varias públicas separadas por coma; las licencias nuevas llevan `kid`.

## Construir un paquete de producción

```bash
npx -y pnpm@11.21.0 --filter @003/packaging build -- \
  --platform win32 --arch x64 \
  --license-public-key ~/.nodo-keys/license-public.pem \
  --hq-url https://<tu-hq>.up.railway.app
```

- Sin `--license-public-key` ni `--license open` la construcción **falla**: hay que elegir.
- `--license open` produce un paquete de **desarrollo** (`…-dev…`): no limita nada, no se distribuye.
- Se rechaza una clave privada en `--license-public-key`.

## Activar un local

1. En el HQ, la plataforma crea la organización y la sucursal (`POST /api/hq/orgs`, `POST /api/hq/branches`); la respuesta incluye `activation_code` (`NODO-XXXX-XXXX-XXXX`, vale 7 días, un solo uso).
2. En el local: *Configuración → Nube y plan → Activar este equipo* y se escribe el código. Necesita Internet **esta vez**.
3. El HQ registra la huella del equipo, entrega una llave nueva y la licencia firmada. Desde ahí el local opera sin red; cada hora intenta renovar.

## Cambio de equipo o código perdido

El propietario (o la plataforma con `x-hq-admin`) emite un código nuevo: `POST /api/hq/branches/:id/activation-code`. Anula los anteriores sin usar. Al canjearlo en el equipo nuevo, la sucursal queda atada a la huella nueva y **la llave del equipo anterior deja de valer**. El identificador corto del equipo (`A1B2-C3D4-E5F6`) aparece en *Nube y plan* para dictarlo por teléfono.

## Suscripción anual

- La organización tiene una fecha **`paid_until`** (hasta cuándo está pagada). La licencia de sus sucursales **vence ese día**; sin fecha (planes de prueba) dura 30 días y se renueva sola.
- Al cobrar la renovación, la plataforma avanza la fecha un año: `PATCH /api/hq/orgs/:id` con `x-hq-admin` y `{ "paid_until": <ms> }`. Cada local la recibe en su siguiente sincronización (cada hora con Internet); **no hay que tocar el local**.
- Si el pago se retrasa, el local **sigue operando 15 días** con su plan (`GRACE_DAYS`); después pasa al plan gratuito sin detener la venta, y vuelve al plan contratado en cuanto se renueva y sincroniza.
- **Cancelación o falta de pago definitiva:** desactivar la organización (`{ "active": false }`). En la siguiente sincronización el HQ responde 401/403 y el local queda **«revocado»** (plan gratuito) aunque su licencia no haya vencido. Reactivarla lo restablece. **Un fallo de red nunca revoca**: solo una negativa del HQ.
- Una renovación anual es también la ocasión natural de cambiar de plan o de equipo.

## Qué pasa en cada estado

| Estado | Efecto |
|---|---|
| Licencia válida | Plan contratado |
| Vencida, dentro de 15 días | Sigue con el plan contratado |
| Sin licencia, firma inválida, otro equipo, vencida más de 15 días, o revocada | Plan **gratuito** (3 usuarios, 1 impresora, sin funciones extra). **Se sigue vendiendo.** |

## Qué protege y qué no (honestidad)

Protege contra: fabricar licencias (clave privada fuera del equipo), sustituir la clave pública, copiar una licencia a otro local, retrasar el reloj para alargarla, y desactivarla con variables de entorno.

**No** impide a alguien con tiempo y acceso al equipo modificar el programa instalado (es JavaScript legible): se asume. La defensa real es que lo valioso vive en el servidor de Nodo (respaldo y restauración, actualizaciones, timbrado, soporte, consola). La ofuscación queda como endurecimiento opcional (D3.7).

## Probado

34 pruebas de servidor del plan 03 (huella, estados, activación, cambio de equipo, límite de intentos), 4 e2e de la pantalla de activación y 4 pruebas del empaquetado (`packaging/test`): el modo y las claves de un paquete de producción no se cambian con el entorno; sin claves el paquete no arranca. El paquete `enforced` se arrancó de verdad (macOS): queda restringido y opera.

## Pendiente

- 🔴 Generar la clave **de producción** y configurar `HQ_SIGNING_KEY` en Railway (lo hace el dueño; no se generó ninguna en esta sesión).
- 🟠 Probar la activación contra un HQ real desplegado (plan 04).
- 🟡 La huella de Windows (`MachineGuid`) y de Linux (`/etc/machine-id`) se probó solo por análisis del texto, no en esos sistemas.
