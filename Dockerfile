# Reviewed build inputs. Update these with the source/image acceptance record.
FROM oven/bun:1.3.10@sha256:b86c67b531d87b4db11470d9b2bd0c519b1976eee6fcd71634e73abfa6230d2e AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
# These VITE values are public browser analytics identifiers, never secrets.
ARG VITE_POSTHOG_KEY
ARG VITE_POSTHOG_HOST
ARG VITE_POSTHOG_INTERNAL_DOMAINS
RUN bun run build

FROM oven/bun:1.3.10@sha256:b86c67b531d87b4db11470d9b2bd0c519b1976eee6fcd71634e73abfa6230d2e AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
WORKDIR /app
# A dated, signed Debian archive keeps Chromium/fonts reproducible. Only the
# archive's expiry check is disabled; package signatures remain mandatory.
# Bootstrap HTTPS from the pinned Node binary's compiled Mozilla roots. The
# signed snapshot then installs Debian's own frozen ca-certificates package.
RUN node -e "const fs=require('node:fs');fs.mkdirSync('/etc/ssl/certs',{recursive:true});fs.writeFileSync('/etc/ssl/certs/ca-certificates.crt',require('node:tls').rootCertificates.join('\n'))" \
  && rm -f /etc/apt/sources.list.d/debian.sources \
  && printf '%s\n' \
    'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20261106T000000Z bookworm main' \
    'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20261106T000000Z bookworm-updates main' \
    'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20261106T000000Z bookworm-security main' \
    > /etc/apt/sources.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates chromium chromium-sandbox fonts-liberation fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/data \
  && chown node:node /app/data

COPY package.json LICENSE ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared

ARG DOOP_SOURCE_FINGERPRINT
RUN test "${#DOOP_SOURCE_FINGERPRINT}" -eq 64 \
  && case "$DOOP_SOURCE_FINGERPRINT" in *[!0-9a-f]*) exit 1;; esac
LABEL org.opencontainers.image.source="https://github.com/kgoedecke/doop" \
  org.opencontainers.image.revision="01584b34f6cadcf21767127280cc6e320a6d748a" \
  io.openbot.doop.source-fingerprint="$DOOP_SOURCE_FINGERPRINT"

ENV NODE_ENV=production CHROME_PATH=/usr/bin/chromium CHROME_NO_SANDBOX=false \
  PORT=4400 HOME=/tmp XDG_CONFIG_HOME=/tmp/config XDG_CACHE_HOME=/tmp/cache
USER node
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "server/index.ts"]
