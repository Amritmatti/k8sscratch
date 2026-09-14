# syntax=docker/dockerfile:1.7
#
# Employee Directory — the browser UI.
#
# A separate image and a separate Deployment from the API on purpose:
#   - the two scale independently (static files are cheap, the API is not)
#   - a UI rollout cannot restart the API, and vice versa
#   - the API keeps its `default-src 'none'` CSP and stays a pure JSON service
#   - nginx serves static bytes far better than Express does
#
# Base image choice: nginx-unprivileged, not plain nginx. The stock image runs
# its master process as root and binds port 80, neither of which the Pod
# Security "restricted" profile allows. This one runs as uid 101 and listens on
# 8080, so no capability and no root user is needed anywhere.
#
# The server config is NOT baked in — the chart renders it into a ConfigMap and
# mounts it at /etc/nginx/conf.d, because the API's Service name depends on the
# Helm release name and is not knowable at build time.
#
# Build:
#   docker build -t employee-frontend:dev ./frontend

FROM nginxinc/nginx-unprivileged:1.27-alpine

# Pick up OS packages patched after the base image was tagged. Without this the
# image ships whatever musl/zlib/nghttp2/libxml2 the base was built with, and
# the CI gate fails on fixable HIGH/CRITICAL findings in packages this
# Dockerfile never installed.
#
# Briefly root because apk needs it; dropped again immediately below, and the
# Pod securityContext enforces non-root regardless.
USER root
RUN apk upgrade --no-cache \
    && rm -rf /var/cache/apk/*

# Already the default in this base image; stated explicitly so that a base
# image change can never silently promote this container to root.
USER 101:101

COPY --chown=101:101 public/ /usr/share/nginx/html/

ARG GIT_COMMIT=unknown
ARG APP_VERSION=dev
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="employee-frontend" \
      org.opencontainers.image.description="Employee Directory UI (static, served by nginx)" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.licenses="MIT"

EXPOSE 8080

# Informational only — Kubernetes uses the probes in the Helm chart.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/bin/sh", "-c", "wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1"]
