import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'vite'

// Use the same .env and PORT as the backend. Do not serve the app until its
// initial auth/config requests can succeed.
const url = `http://localhost:${Number(process.env.PORT || 4400)}/healthz`
const deadline = Date.now() + 60_000
console.log(`Waiting for Doop backend at ${url}…`)
let ready = false
while (Date.now() < deadline) {
  try {
    const response = await globalThis.fetch(url, { signal: globalThis.AbortSignal.timeout(1000) })
    if (response.ok && (await response.json()).ok === true) {
      ready = true
      break
    }
  } catch {
    // The backend is still initializing its database and authentication.
  }
  await delay(200)
}
if (!ready) throw new Error('Doop backend did not start within 60 seconds. Check the [server] output above.')

const server = await createServer()
let closing = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (closing) return
    closing = true
    void server.close().finally(() => process.exit(0))
  })
}
await server.listen()
server.printUrls()
