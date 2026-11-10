# The suite as CI runs it: Linux, two CPUs, a headless Chromium. Built and run
# by scripts/test-linux.sh, for a browser test that fails on CI and passes on
# a Mac. The context is the repository, so the image carries the working tree.
FROM node:22-bookworm

# Chrome for Testing has no Linux arm64 build, so an Apple Silicon Mac gets
# Debian's Chromium here; an x64 host gets the Chrome CI pins (.chrome-version).
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g bun@1.3.10

WORKDIR /work
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY .chrome-version ./
RUN if [ "$(dpkg --print-architecture)" = amd64 ]; then \
      ./node_modules/.bin/browsers install "chrome@$(cat .chrome-version)" --path /opt/chrome \
        | awk '{ print $2 }' > /opt/chrome-path; \
    else echo /usr/bin/chromium > /opt/chrome-path; fi
COPY . .

# root in a container has no user namespaces for Chromium's sandbox
ENV CI=true CHROME_NO_SANDBOX=1
ENTRYPOINT ["sh", "-c", "CHROME_PATH=$(cat /opt/chrome-path) exec bun run test -- \"$@\"", "test"]
