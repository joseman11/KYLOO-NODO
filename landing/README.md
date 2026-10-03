# Nodo · landing (Next.js)

Página de venta de Nodo. Next.js 15 (App Router) + TypeScript, sin librerías de UI. Lista para Railway.

```bash
npm install
npm run dev          # http://localhost:3000
npm run build && npm start
```

## Despliegue en Railway
1. Sube esta carpeta (`landing/`) a un repositorio, o crea el servicio apuntando a ella.
2. En Railway: **New Project → Deploy from GitHub repo** (Railway detecta Next.js con Nixpacks; `railway.json` ya define build, start y healthcheck).
3. En **Variables** agrega las de `.env.example` (`NEXT_PUBLIC_WHATSAPP` o `NEXT_PUBLIC_CONTACT_EMAIL`, y `NEXT_PUBLIC_SITE_URL`). Al ser `NEXT_PUBLIC_*` se leen al compilar: vuelve a desplegar tras cambiarlas.
4. En **Settings → Networking** genera el dominio (o conecta el tuyo).
Railway inyecta `PORT`; `npm start` ya escucha en `0.0.0.0`.

## Videos (.mp4)
Están en `public/videos/` y se **renderizan desde HTML**: `video-src/` contiene una "película" (HTML + JS) que anima el DOM real de la app
(cursor, toques, cámara, subtítulos, tickets que se imprimen) como función del tiempo y la captura cuadro por cuadro con Chrome
a 1920×1080, 30 fps; ffmpeg las codifica en H.264.

```bash
cd video-src && npm install
# 1) con la demo de mariscos corriendo (puerto 3006) y la app compilada:
npm run states        # captura el DOM real de la app en cada paso
# 2) renderiza
npm run render-all    # pedido, cocina, cobro y hero → ../public/videos
node render.mjs pedido --preview 3,9,18   # PNG de esos segundos para revisar
```
Los guiones están en `video-src/film/scenes.js`; el motor, en `video-src/film/engine.js`.
Las rutas se resuelven en `video-src/paths.mjs`: Chrome por `CHROME_PATH` (o el primero que exista), la app compilada por `NODO_APP_DIST` y las fotos de la demo por `NODO_LANDING_PHOTOS`; por defecto, relativas a este repositorio.

## Estructura
- `app/` página (`page.tsx`), estilos (`globals.css`) y tipografías locales (Bricolage Grotesque, Inter, IBM Plex Mono).
- `components/` video en bucle, olas WebGL del pie, formulario y logotipo de Kyloo.
- `public/` videos, capturas y logotipos (SVG).
