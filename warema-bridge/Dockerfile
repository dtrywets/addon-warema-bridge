################################################################################
# Build arguments (müssen vor dem ersten FROM stehen)
ARG BUILD_FROM=hassioaddons/base:edge
################################################################################

################################################################################
# 1) Builder Stage: öffentliches Node 18‑Alpine‑Image zum Kompilieren
################################################################################
FROM node:18-alpine AS builder

ENV LANG C.UTF-8

# Build‑Tools für native Module
RUN apk add --no-cache python3 make g++ linux-headers

WORKDIR /srv

# Node‑Deps installieren & bauen
COPY warema-bridge/rootfs/srv/package*.json ./
RUN npm ci

# Restlichen Code rein
COPY warema-bridge/rootfs/srv/ ./

################################################################################
# 2) Runtime Stage: HA‑Base ohne npm oder Build‑Deps
################################################################################
FROM ${BUILD_FROM}

SHELL ["/bin/bash","-o","pipefail","-c"]

ENV LANG C.UTF-8

# Nur socat brauchen wir noch
RUN apk add --no-cache socat

# Übernimm alles aus dem Builder (inkl. node_modules!)
COPY --from=builder /srv /srv

# Kopiere deine s6‑Services
COPY warema-bridge/rootfs/etc /etc

WORKDIR /srv

# Kein CMD/ENTRYPOINT: HA‑Supervisor nutzt /init automatisch
