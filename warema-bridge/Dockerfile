# Nutze das Node 18‑basierte Home Assistant Base‑Image
ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-node:18.16.0
FROM ${BUILD_FROM}

# Set locale
ENV LANG C.UTF-8

# Socat und Build‑Deps installieren
RUN apk add --no-cache socat \
 && apk add --no-cache --virtual .build-deps \
      python3 make g++ linux-headers

# Package‑Manifeste kopieren
COPY rootfs/srv/package-lock.json /srv/
COPY rootfs/srv/package.json      /srv/

WORKDIR /srv

# Node‑Module installieren (inkl. @serialport/bindings)
RUN npm ci

# Build‑Deps und Cache wieder entfernen
RUN apk del .build-deps \
 && rm -rf /root/.npm /root/.cache

# Rest der Add‑on‑Dateien ins Image
COPY rootfs/ /

# Kein CMD/ENTRYPOINT setzen – HA verwendet /init automatisch
