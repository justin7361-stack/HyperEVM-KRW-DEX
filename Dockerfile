##
## HyperKRW DEX Server — Dockerfile (O-6)
##
## Multi-stage build:
##   1. builder — installs all deps + compiles TypeScript
##   2. runner  — production image (no dev deps, no src, minimal attack surface)
##
## Build:  docker build -t krw-dex-server .
## Run:    docker run --env-file .env -p 3000:3000 krw-dex-server
##

# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy manifests first (Docker cache layer)
COPY package.json package-lock.json ./

# Install ALL deps (including devDependencies for tsc)
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src ./src

# Compile TypeScript → dist/
RUN node_modules/.bin/tsc --project tsconfig.json

# Install optional runtime deps if env vars indicate they'll be used.
# These are excluded from package.json to keep default install lean.
# In CI/CD, pass --build-arg WITH_POSTGRES=1 --build-arg WITH_REDIS=1.
ARG WITH_POSTGRES=0
ARG WITH_REDIS=0
RUN if [ "$WITH_POSTGRES" = "1" ]; then npm install postgres; fi
RUN if [ "$WITH_REDIS" = "1" ]; then npm install ioredis; fi

# ── Stage 2: Production Runtime ───────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy only production artefacts
COPY package.json package-lock.json ./

# Install production deps only
RUN npm ci --omit=dev

# Copy compiled JS from builder
COPY --from=builder /app/dist ./dist

# Copy optional dep node_modules installed in builder (postgres, ioredis)
COPY --from=builder /app/node_modules/postgres ./node_modules/postgres 2>/dev/null || true
COPY --from=builder /app/node_modules/ioredis ./node_modules/ioredis 2>/dev/null || true
COPY --from=builder /app/node_modules/cluster-key-slot ./node_modules/cluster-key-slot 2>/dev/null || true

# Non-root user for security
RUN addgroup -S krwdex && adduser -S krwdex -G krwdex
USER krwdex

EXPOSE 3000

# Graceful shutdown: Docker sends SIGTERM, Node receives it → gracefulShutdown()
STOPSIGNAL SIGTERM

CMD ["node", "--experimental-vm-modules", "dist/index.js"]
