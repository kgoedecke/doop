# ---- build the client ----
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .

# Vite inlines these at build time, so they must be present *here*, not at
# runtime — without them the bundle ships with analytics silently disabled.
# Railway matches these ARG names against the service variables and passes
# them in; Docker exposes them to RUN, which is where vite reads them.
# The project key is a public, write-only token that ships to every visitor
# in the JS bundle regardless; it is not a secret.
# VITE_POSTHOG_HOST is deliberately left unset: the client then defaults to
# the same-origin /relay proxy, which is what defeats ad blockers. Setting
# it to a posthog.com host would bypass the relay and resurrect blocking.
ARG VITE_POSTHOG_KEY
ARG VITE_POSTHOG_HOST
# comma-separated email domains whose sessions skip replay (operator accounts)
ARG VITE_POSTHOG_INTERNAL_DOMAINS

RUN bun run build

# ---- runtime dependencies ----
# Installed by bun, but into a plain node_modules the Node runtime below reads
# directly — bun is the package manager here, not the runtime.
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- runtime ----
# Node, not bun: the server runs under tsx, and puppeteer-core, PGlite and ws
# are exercised on Node in CI and in every dev session.
FROM node:22-slim
WORKDIR /app

# Chromium for get_frame_screenshot (puppeteer-core drives the system browser).
# Its fonts are what screenshots, thumbnails and PDF exports fall back to when a
# frame's own font lacks a glyph: Liberation for the metric-compatible basics,
# DejaVu for symbols (arrows, geometric shapes, dingbats; without it ✕ □ ⟶ draw
# as empty boxes and ↗ as an emoji), Noto Color Emoji for emoji.
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium \
    fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium \
    CHROME_NO_SANDBOX=1 \
    PORT=4400

COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared

# Run as an unprivileged user: frame HTML (agent-written, untrusted) is executed
# by the bundled Chromium for screenshots, thumbnails and PDF export, and the
# process holds DATABASE_URL and SECRETS_ENCRYPTION_KEYS. Chromium still runs
# with --no-sandbox (CHROME_NO_SANDBOX=1) because the default Docker seccomp
# profile blocks the user namespaces its sandbox needs; a renderer escape then
# lands in this user, not root. To restore Chromium's own sandbox, run the
# container with a seccomp profile that allows unprivileged user namespaces
# and unset CHROME_NO_SANDBOX.
RUN groupadd -r -g 10001 doop && useradd -r -u 10001 -g doop -d /app -s /usr/sbin/nologin doop \
  && mkdir -p /app/data && chown -R doop:doop /app
USER doop

EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# the installed binary rather than npx: npm is not what resolves packages here
CMD ["node_modules/.bin/tsx", "server/index.ts"]
