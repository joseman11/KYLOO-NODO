# El servidor de Nodo (HQ) en Railway

> Vigente al 2026-10-03. **Desplegado** el mismo día en el workspace *Ander's Projects* de Railway, proyecto **`nodo-hq`** (ID `99f14134-a782-46d2-b08a-41793f658708`), servicio `nodo-hq` + PostgreSQL + volumen `/data`, en **https://nodo-hq-production.up.railway.app** (`/api/health` → `engine: pg`). Probado contra ese servidor real con un paquete de producción firmado con la clave de producción: activar con código, plan hasta `paid_until`, respaldar y restaurar.
>
> **Cómo se desplegó:** con la CLI de Railway subiendo el código local (`railway up --service nodo-hq` desde `003/`), sin publicar nada en GitHub. Para actualizar: lo mismo desde `003/`. Los secretos están en las variables del servicio; los originales, en `~/.nodo-keys/` del Mac del dueño (`license-private.pem`, `hq-admin-token`, permisos 600): **hacer copia fuera de línea**.
>
> ⚠️ Railway marca `railway.json` como «Config as Code» obsoleto (sigue funcionando hasta **2026-12-01**): migrar con `railway config migrate`.

## Qué es

El mismo programa que corre en un local, con `ROLE=hq`: organizaciones y sucursales, **licencias firmadas**, ventas consolidadas, catálogo maestro y **respaldos cifrados**. Usa PostgreSQL (esquema `hq`) y un volumen para los respaldos. Nunca recibe datos legibles de un local: los respaldos llegan cifrados con una clave que solo tiene el cliente.

## Una sola vez: crear el servicio (ya hecho; queda como referencia)

1. **Claves de licencias** (si aún no existen): `npx -y pnpm@11.21.0 --filter @003/server keygen -- --out ~/.nodo-keys`. La pública se usa al empaquetar los locales; la **privada** va solo a Railway y a una copia de seguridad. Ver [`LICENCIAS.md`](LICENCIAS.md).
2. En Railway: **New Project → Deploy from GitHub repo → `KYLOO-NODO`**. Este servicio es distinto del de la landing (que ya usa `Root Directory = /landing`).
3. **Settings → Source → Root Directory = `/003`**. Railway usa `003/Dockerfile` y `003/railway.json` (construcción con Docker, comprobación de salud en `/api/health`).
4. **Agregar PostgreSQL**: *New → Database → PostgreSQL*. Railway define `DATABASE_URL` para el servicio (referencia entre servicios: `${{Postgres.DATABASE_URL}}`).
5. **Agregar un volumen** al servicio, montado en **`/data`** (ahí viven los respaldos cifrados en `/data/cloud-backups`).
6. **Variables del servicio:**

| Variable | Valor | Nota |
|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Obligatoria |
| `HQ_SIGNING_KEY` | contenido de `license-private.pem` (los saltos de línea pueden ir como `\n`) | **Obligatoria**: sin ella el HQ no arranca en producción. Secreto. |
| `HQ_ADMIN_TOKEN` | una cadena larga y aleatoria | Es la llave de la plataforma para crear organizaciones. Secreto. |
| `HQ_KEY_ID` | `k1` | Identifica la clave de firma (para rotarla) |
| `NODO_DATA_DIR` | `/data` | Ya viene en la imagen |
| `DATABASE_SSL` | `1` solo si se usa la URL pública de la base | Dentro de la red de Railway no hace falta |
| `PORT` | lo pone Railway | |

7. **Settings → Networking → Generate Domain** (o un dominio propio). Esa URL es la que va en `--hq-url` al empaquetar los locales.
8. Si Railway ejecuta el contenedor sin permisos sobre el volumen, añade `RAILWAY_RUN_UID=0`.

## Operación

- **Alta de un cliente:** `POST /api/hq/orgs` con la cabecera `x-hq-admin: <HQ_ADMIN_TOKEN>` → el propietario entra a `/hq` → *Sucursales → Crear sucursal* muestra el **código de activación** (o `POST /api/hq/branches`). Ver [`LICENCIAS.md`](LICENCIAS.md).
- **Salud:** `GET /api/health` (versión, motor `pg`, tiempo en marcha). Los registros salen por la consola de Railway.
- **Copias del propio HQ:** la base la respalda Railway (activa los respaldos del plugin de PostgreSQL); el **volumen** con los respaldos de los clientes no tiene copia automática: es el eslabón que falta (ver pendiente).
- **Límites:** por archivo 512 MB y por sucursal 5 GB (`backupMaxBytes`, `branchQuotaBytes`); retención de 14 respaldos recientes más el último de cada uno de los 6 meses anteriores.

## Probarlo en local (lo que se hizo)

```bash
cd 003
docker build -t nodo-hq:test .
docker run -d --name nodo-hq-test -p 3050:3000 -v /tmp/hq-data:/data \
  -e DATABASE_URL=postgres://postgres:nodo@host.docker.internal:5433/nodo_test \
  -e HQ_ADMIN_TOKEN=secreto -e HQ_SIGNING_KEY="$(cat ~/.nodo-keys/license-private.pem)" nodo-hq:test
curl localhost:3050/api/health        # {"ok":true,…,"engine":"pg"}
```

## Pendiente

- 🔴 Primera instalación real en Railway y comprobar el recorrido completo contra esa URL.
- 🟠 Copia de seguridad del volumen de respaldos (réplica a otro almacenamiento) y plan de recuperación si se pierde el volumen.
- 🟡 La consola web del HQ (`/hq`, *Sucursales*) ya crea sucursales, emite códigos de activación (la llave de sucursal ya no se muestra) y muestra el equipo activado y el último respaldo de cada una; faltan la descarga/borrado de respaldos y el panel de uso de espacio.
- 🟡 Probar el cifrado de extremo a extremo con un respaldo de varios cientos de MB (las pruebas cubren bloques, bordes y manipulación, no volúmenes grandes).
