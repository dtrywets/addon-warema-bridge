ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-node:18.16.0
FROM ${BUILD_FROM}

# Locale
ENV LANG C.UTF-8

# Install socat and the build dependencies for native modules
RUN apk add --no-cache socat \
    && apk add --no-cache --virtual .build-deps \
         python3 make g++ linux-headers

# Copy package definitions
COPY rootfs/srv/package-lock.json /srv/
COPY rootfs/srv/package.json      /srv/

WORKDIR /srv

# Install Node.js dependencies (including @serialport/bindings)
RUN npm ci

# Remove build dependencies and caches to slim down the image
RUN apk del .build-deps \
    && rm -rf /root/.npm /root/.cache

# Copy the rest of the add‑on filesystem
COPY rootfs/ /

# No CMD or ENTRYPOINT: Home Assistant injects /init for s6-overlay
