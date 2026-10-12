FROM node:26-slim

COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /usr/local/bin/uv

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY static ./static

# Package caches and uv-managed Python live under /data so the image stays small and installs survive upgrades.
ENV NODE_ENV=production \
    MCPYARD_CONFIG=/config/mcpyard.yaml \
    MCPYARD_DATA_DIR=/data \
    MCPYARD_PORT=3000 \
    npm_config_cache=/data/cache/npm \
    UV_CACHE_DIR=/data/cache/uv \
    UV_PYTHON_INSTALL_DIR=/data/python

RUN mkdir -p /data /config && chown node:node /data

# Last, so a new version does not invalidate the layers above.
ARG VERSION=dev
ENV MCPYARD_VERSION=$VERSION
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.MCPYARD_PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/main.ts"]
