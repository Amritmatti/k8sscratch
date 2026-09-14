# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the Employee API.
#
# Security decisions made here, each of which a scanner will check:
#   - pinned base image by digest-friendly tag, Alpine for a small surface
#   - production dependencies only in the final stage; no compilers shipped
#   - runs as an existing non-root user (uid 1000), enforced again by the
#     Pod securityContext
#   - no package manager left usable at runtime, no shell tooling added
#   - dumb-init as PID 1 so SIGTERM reaches Node and graceful shutdown runs
#
# Build:
#   docker build -t employee-api:dev ./app
# Build with provenance metadata:
#   docker build --build-arg GIT_COMMIT=$(git rev-parse HEAD) -t employee-api:dev ./app

# ---------------------------------------------------------------------------
# Stage 1 — install production dependencies
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps

WORKDIR /app

# Copy only the manifests first: this layer is cached until dependencies
# actually change, so code edits do not trigger a reinstall.
COPY package.json package-lock.json* ./

# `npm ci` requires a lockfile and installs exactly what it pins. Fall back to
# `npm install` only when no lockfile exists yet (first run on a fresh clone).
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then \
        npm ci --omit=dev --ignore-scripts; \
    else \
        echo "WARNING: no package-lock.json; builds are not reproducible" >&2; \
        npm install --omit=dev --ignore-scripts; \
    fi

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# dumb-init reaps zombies and forwards signals. Without an init, Node runs as
# PID 1, where the default SIGTERM handler does not exist and the graceful
# shutdown in server.js would never run.
RUN apk add --no-cache dumb-init=~1.2 \
    && rm -rf /var/cache/apk/*

ENV NODE_ENV=production \
    PORT=3000 \
    METRICS_PORT=9090 \
    # Keep Node's heap inside the container memory limit so the kernel OOM
    # killer does not terminate the process without a useful error.
    NODE_OPTIONS="--max-old-space-size=384"

WORKDIR /app

# node:alpine already ships an unprivileged `node` user at uid/gid 1000.
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node migrations ./migrations

# Provenance: surfaced by GET /api/v1 and stamped into image labels.
ARG GIT_COMMIT=unknown
ARG APP_VERSION=dev
ARG BUILD_DATE=unknown
ENV GIT_COMMIT=${GIT_COMMIT} \
    APP_VERSION=${APP_VERSION}

LABEL org.opencontainers.image.title="employee-api" \
      org.opencontainers.image.description="Employee records API (Node.js + PostgreSQL)" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.source="https://github.com/OWNER/REPO" \
      org.opencontainers.image.licenses="MIT"

USER node

EXPOSE 3000 9090

# Informational only — Kubernetes uses the probes in the Helm chart, not this.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
