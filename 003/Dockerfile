# Servidor HQ de Nodo (nube): el mismo código que corre en un local, con ROLE=hq y PostgreSQL.
# Contexto de construcción: esta carpeta (003/). En Railway: Root Directory = /003 (ver docs/deploy/HQ-RAILWAY.md).
FROM node:24-slim AS build
RUN npm install -g pnpm@11.21.0
WORKDIR /app
# Primero solo los manifiestos: la instalación de dependencias queda en caché mientras no cambien
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packaging/package.json packaging/
RUN pnpm install --frozen-lockfile --filter "@003/server..." --filter "@003/web..." --filter "@003/packaging..."
COPY apps/server apps/server
COPY apps/web apps/web
COPY packages/shared packages/shared
COPY packaging packaging
RUN pnpm --filter @003/web build && node packaging/bundle.mjs /out

FROM node:24-slim
ENV NODE_ENV=production \
    ROLE=hq \
    NODO_DATA_DIR=/data \
    PORT=3000 \
    HOST=0.0.0.0
WORKDIR /srv
COPY --from=build /out ./
# Los respaldos cifrados de las sucursales viven en el volumen montado en /data (Railway lo monta; no admite la
# instrucción VOLUME. Con Docker a secas: `docker run -v <carpeta>:/data`)
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]
