################################################################################
# Build‑Arg (muss VOR jedem FROM stehen)
ARG BUILD_FROM=hassioaddons/base:edge
################################################################################

################################################################################
# 1) Builder Stage: Node 18 Alpine zum Kompilieren
################################################################################
FROM node:18-alpine AS builder

ENV LANG C.UTF-8

# Build‑Tools für native Add‑On‑Module
RUN apk add --no-cache python3 make g++ linux-headers

WORKDIR /srv

# package.json + lock kopieren und Dependencies bauen
COPY rootfs/srv/package*.json ./
RUN npm ci

# Restlichen Bridge‑Code rein
COPY rootfs/srv/ ./

################################################################################
# 2) Runtime Stage: schlankes HA‑Base ohne npm oder Build‑Deps
################################################################################
FROM ${BUILD_FROM}

SHELL ["/bin/bash","-o","pipefail","-c"]
ENV LANG C.UTF-8

# Nur socat brauchen wir noch
RUN apk add --no-cache socat

# Vorinstallierte Bridge‑App (inkl. node_modules) aus dem Builder holen
COPY --from=builder /srv /srv

# Deine S6‑Services (run/finish) kopieren
COPY rootfs/etc /etc

WORKDIR /srv

# Kein CMD/ENTRYPOINT nötig – HA‑Supervisor injiziert /init automatisch
