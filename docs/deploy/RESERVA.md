# Servidor de reserva

> Vigente al 2026-10-03 (plan 07). Diseño y razones: [`PLAN-07`](../PLAN-07-SERVIDOR-DE-RESERVA.md). **Probado** con dos procesos reales (copia, caída del principal, promoción, acceso con las mismas credenciales) y con Chrome automatizado; **sin probar en dos equipos físicos ni con una tablet real**.

## Para qué sirve

Si la PC del local se descompone en pleno servicio, una **segunda PC** (la reserva) ya tiene una copia de todo —cuentas, menú, usuarios, fotos— de hace pocos minutos y se convierte en el servidor con un botón. No hace falta internet ni a Nodo: todo ocurre en la red del local.

## Montarla (una vez)

1. En el servidor principal: *Configuración → Conectar → **Servidor de reserva** → Emparejar una reserva*. Pide tu contraseña y muestra la **clave de emparejamiento** junto con el comando exacto.
2. En la PC de reserva: instala Nodo (el mismo instalador) **sin hacer el asistente de primer arranque** y ejecuta, con la clave de la pantalla:
   ```
   node server.mjs standby --of http://<IP del principal>:3003 --key <clave>
   ```
   Reinicia el servicio de Nodo. La reserva abre `http://<su IP>:3003` y muestra una página de estado.
3. Cada **5 minutos** copia al principal. En el principal, la tarjeta dice «Última copia de la reserva: hace N min» y se pone en rojo si pasan más de 20.

La copia viaja **cifrada** (una clave derivada del emparejamiento, distinta del token con el que la reserva se identifica) y se comprueba entera (integridad de SQLite) antes de reemplazar la anterior: una descarga dañada o a medias **nunca** pisa la última copia buena.

## Cuando el principal se cae

1. Abre en cualquier navegador `http://<IP de la reserva>:3003`: dice si el principal responde y cuándo fue la última copia.
2. Escribe la clave de emparejamiento y pulsa **Promover a principal**. Si el principal sí responde, pide confirmación extra (dos servidores a la vez es lo que hay que evitar).
3. En unos segundos la reserva ya es el servidor: mismos usuarios, mismas contraseñas, mismas mesas y cuentas **hasta la última copia** (lo hecho en los últimos minutos antes de la caída puede faltar).
4. **Apaga el equipo viejo** (o quítale el servicio) antes de repararlo. Si vuelve a encenderse con la red conectada, habría dos servidores con datos distintos.

### Las tablets
- **App de tablet:** mientras el servidor responde, aprende la dirección de la reserva. Si el servidor deja de contestar, muestra «buscando el servidor de reserva» y, cuando la reserva ya es principal, **se pasa sola**. Si la reserva existe pero nadie la ha promovido, el aviso dice a qué dirección ir.
- **Navegadores:** un navegador no puede consultar otro servidor por seguridad, así que **no se pasan solos**: usa el nombre `http://nodo.local:3003`, que la reserva anuncia en cuanto se promueve (y que no todos los dispositivos resuelven), o la dirección de la reserva.

## Límites que hay que conocer

- **Licencia:** la licencia está atada al equipo. La reserva, al promoverse, trabaja con el **plan gratuito** hasta que el propietario genere un código de activación nuevo en el HQ y la active (la venta nunca se detiene). Hazlo cuanto antes tras promover.
- **Pérdida acotada, no cero:** lo ocurrido entre la última copia y la caída se pierde. Una réplica continua (por eventos) queda como mejora (plan 07, «Pendiente»).
- **No es automático a propósito:** la promoción la decide una persona; una red que se corta un momento no debe producir dos servidores.
- Volver a dejar el equipo viejo como principal y la reserva como reserva no tiene botón: se hace emparejando de nuevo (`standby --off` en quien ya no lo es).

## Quitar la reserva

En el principal: *Quitar reserva* (la reserva deja de poder descargar). En la reserva: `node server.mjs standby --off` y reiniciar el servicio.

## Comprobar que funciona (sin esperar una avería)

Con la reserva montada, mira «Última copia de la reserva» en el principal. Una vez al mes, abre la página de la reserva y confirma «responde» y una copia reciente. **No promuevas para probar** en horario de servicio.
