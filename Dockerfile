# simple timeline — built by Jenkins against minikube's docker daemon, so the
# image lands directly where the cluster pulls from (imagePullPolicy: IfNotPresent).
#
# Node 24+ is not optional: SQLite comes from node:sqlite in core and the server
# runs TypeScript through Node's own type stripping, with no build step.

# ---------------------------------------------------------------- build
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY index.html vite.config.ts tsconfig.json ./
COPY client ./client
COPY shared ./shared
COPY server ./server
COPY tests ./tests

# A broken build must fail here, not in the cluster.
RUN npx tsc --noEmit && npx vitest run && npm run build

# ---------------------------------------------------------------- runtime
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    TIMELINE_DB=/app/data/timeline.db \
    NODE_OPTIONS=--no-warnings=ExperimentalWarning

# express is the only runtime dependency; react is compiled into dist.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared

# The data directory is a mount point for the PVC. Creating it here with the
# right owner means the pod can write even before fsGroup is applied.
RUN mkdir -p /app/data && chown -R node:node /app

# node:alpine's `node` user is UID 1000, which is what the pod securityContext
# pins. Naming the user is not enough for runAsNonRoot — the manifest sets the UID.
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.ts"]
