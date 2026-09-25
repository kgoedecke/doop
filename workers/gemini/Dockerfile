FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM node:22-slim
# Pin the CLI surface exercised by this prototype. Google sign-in remains in
# this unmodified official CLI; Doop never imports its authentication internals.
RUN npm install --global @google/gemini-cli@0.61.0 \
    && npm cache clean --force \
    && mkdir -p /home/node/.gemini \
    && chown node:node /home/node/.gemini
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY shared/geminiCloud.ts ./shared/
COPY server/geminiCloudRuns.ts server/geminiCloudWorker.ts server/geminiCloudWorkerMain.ts ./server/
USER node
ENV PORT=4401
EXPOSE 4401
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "server/geminiCloudWorkerMain.ts"]
