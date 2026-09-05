import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

/* Dev ports. The defaults are the only ones anyone normally needs; the env
   overrides exist so a second worktree can run its own pair without fighting
   the first for :4300/:4400. PORT is the same variable the server reads, so
   the proxy always points at whichever backend this `npm run dev` started. */
const apiPort = Number(process.env.PORT || 4400)
const webPort = Number(process.env.VITE_PORT || 4300)
const api = `http://localhost:${apiPort}`

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: webPort,
    watch: {
      ignored: ['**/desktop/src-tauri/target/**'],
    },
    /* the doop-sync snippet posts to /ingest from foreign origins; vite
       answers CORS preflights itself before the proxy, so its default
       same-origin policy would block what the express server (prod) allows */
    cors: true,
    proxy: {
      /* changeOrigin stays OFF so the backend sees the web origin's Host and
         better-auth builds OAuth discovery/authorize URLs on that origin —
         the one that serves the login page and that MCP clients connect to */
      '/api': { target: api },
      '/mcp': { target: api },
      '/i': { target: api },
      '/a/': { target: api },
      '/u/': { target: api },
      '/ingest': { target: api },
      '/relay': { target: api },
      '/blog': { target: api },
      '/robots.txt': { target: api },
      '/sitemap.xml': { target: api },
      '/.well-known': { target: api },
      '/ws': { target: `ws://localhost:${apiPort}`, ws: true },
    },
  },
})
