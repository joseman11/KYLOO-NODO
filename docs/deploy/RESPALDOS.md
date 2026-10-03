# Respaldos en la nube y recuperación

> Vigente al 2026-10-03 (plan 04). Diseño y razones: [`PLAN-04`](../PLAN-04-RESPALDO-EN-NUBE.md). Servidor: [`HQ-RAILWAY.md`](HQ-RAILWAY.md).

## Cómo funciona

1. Cada 24 h (y con «Respaldar ahora» en *Configuración → Nube y plan*) el local arma un paquete: una **instantánea consistente de la base** más las **fotos de platillos**.
2. Lo **cifra en el propio equipo** (AES-256-GCM por bloques) con la **clave de recuperación** del local y lo sube al HQ. El HQ solo guarda texto cifrado: ni Nodo ni quien robe el servidor puede leerlo.
3. Si no hay Internet, el local sigue vendiendo y reintenta con espera creciente (1, 2, 4… hasta 60 min). El estado (último éxito, último error con su motivo) se ve en la pantalla.
4. El HQ conserva los 14 respaldos más recientes y el último de cada uno de los 6 meses anteriores.

## La clave de recuperación

Es una cadena de 55 símbolos (`ABCDE-FGHIJ-…`) con suma de control para detectar errores de tecleo. **Sin ella, un respaldo no se puede abrir y Nodo no puede ayudar.** Por eso:

- Se muestra al activar los respaldos hasta que la persona pulsa **«Ya la guardé»**; la pantalla avisa mientras falte.
- Después solo se vuelve a ver escribiendo la contraseña del administrador.
- Debe guardarse **en papel y fuera de la computadora** del local (junto con el código de activación, en un sobre, con el propietario).

## Recuperar un local en una PC nueva

1. El propietario (o Nodo) emite un **código de activación nuevo** de la sucursal (`POST /api/hq/branches/:id/activation-code`). Al canjearlo, la llave del equipo anterior deja de valer.
2. Instalar Nodo en la PC nueva (ver [`INSTALACION.md`](INSTALACION.md)) **sin** abrir el asistente de primer arranque, y en una terminal:

```bash
node app/server.mjs restore --hq-url https://<hq> --code NODO-XXXX-XXXX-XXXX --key ABCDE-FGHIJ-…
# opciones: --data-dir <carpeta>   --force (reemplaza una base existente; la anterior se aparta, no se borra)
```

3. El comando activa la PC, baja el respaldo más reciente, **verifica su suma, lo descifra con autenticación, comprueba la integridad de la base** y deja base y fotos en su sitio, ya vinculados con la licencia nueva. Si algo falla (clave equivocada, archivo alterado, descarga dañada) no instala nada y dice por qué.
4. Arrancar el servicio. Se entra con los mismos usuarios de siempre.

## Qué se probó

54 pruebas de servidor (cifrado, manipulación y truncado, paquete, subida, cuota, retención, reintentos, recuperación completa en otro equipo, claves equivocadas, base existente), 5 e2e de la pantalla y una **prueba real de extremo a extremo**: HQ en un contenedor sobre PostgreSQL, un local empaquetado que activa, respalda (688 KB) y se restaura en otra carpeta, y entra con las mismas credenciales.

## Límites conocidos

- Si se pierden a la vez la computadora **y** la clave de recuperación, los datos del respaldo no se pueden recuperar (decisión de diseño: Nodo no guarda la clave).
- El respaldo es completo, no incremental: con bases de cientos de MB la subida diaria pesa; si hace falta, se pasa a incrementales en una etapa posterior.
- Un respaldo restaurado trae los datos al momento del último respaldo (hasta 24 h de atraso): **no es replicación en tiempo real**.
