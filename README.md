# KYLOO · NODO

Monorepo de **Nodo**, el comandero para restaurantes que funciona en red local, y su página de venta.

| Carpeta | Qué es |
|---|---|
| `003/` | **Nodo** (el software): servidor Fastify + SQLite, app web React (PWA) y pruebas. Ver `003/README.md`. |
| `landing/` | **Página de venta** en Next.js, con videos `.mp4` renderizados desde HTML. Ver `landing/README.md`. |

## Documentación
Todo lo persistente vive en [`docs/`](docs/README.md); el contexto de trabajo, en [`CLAUDE.md`](CLAUDE.md) y [`STRUCTURE.md`](STRUCTURE.md).

## Desplegar solo la landing en Railway

El repositorio contiene todo, pero en Railway solo se despliega `landing/`:

1. Railway → **New Project → Deploy from GitHub repo** → elige `KYLOO-NODO`.
2. En el servicio: **Settings → Source → Root Directory** = `/landing` (así Railway ignora `003/`).
3. **Variables**: `NEXT_PUBLIC_WHATSAPP` o `NEXT_PUBLIC_CONTACT_EMAIL` (donde llegan las solicitudes de demo) y `NEXT_PUBLIC_SITE_URL` (tu dominio público).
4. **Settings → Networking → Generate Domain** (o conecta tu dominio).

El build y el arranque ya están definidos en `landing/railway.json` (Nixpacks, `npm run build` / `npm run start`, healthcheck en `/`).
