import http from 'node:http'
import { freePort } from './harness.ts'

/**
 * A stand-in Glassray for the integration tests. The suite's servers are real
 * child processes, so a fake fetch inside the test cannot see what they send:
 * this records the POSTs to /v1/signals instead. Point a server at it with
 * `startServer({ GLASSRAY_API_KEY: 'gr_test', GLASSRAY_ENDPOINT: sink.origin })`.
 */

/** One signal as @glassray/signals puts it on the wire. */
export interface SentSignal {
  source: 'user' | 'agent'
  kind: string
  message?: string
  work_item?: string | { type: string; id: string }
  refs?: { user?: string; trace?: string }
  agent?: { name?: string; client?: string }
  context?: Record<string, unknown>
  sentiment?: string
  tool?: string
}

export interface GlassraySink {
  origin: string
  signals: SentSignal[]
  /** Every signal sent so far that matches, waiting up to `ms` for the first one. */
  waitFor(match: (s: SentSignal) => boolean, ms?: number): Promise<SentSignal[]>
  /** Nothing matched after `ms`. Proves an action sent no signal. */
  expectNone(match: (s: SentSignal) => boolean, ms?: number): Promise<void>
  clear(): void
  close(): Promise<void>
}

/** The SDK batches every second, so a wait has to outlast one flush. */
const SETTLE_MS = 2500

export async function startGlassraySink(): Promise<GlassraySink> {
  const signals: SentSignal[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/signals') {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as { signals?: SentSignal[] }
          signals.push(...(body.signals ?? []))
        } catch {
          /* a body we cannot read is a test bug, not a server failure */
        }
      }
      res.writeHead(202, { 'Content-Type': 'application/json' }).end('{}')
    })
  })
  const port = await freePort()
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))

  const matches = (match: (s: SentSignal) => boolean) => signals.filter(match)
  const until = async (done: () => boolean, ms: number) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline && !done()) await new Promise((r) => setTimeout(r, 50))
  }

  return {
    origin: `http://127.0.0.1:${port}`,
    signals,
    async waitFor(match, ms = SETTLE_MS) {
      await until(() => matches(match).length > 0, ms)
      return matches(match)
    },
    async expectNone(match, ms = SETTLE_MS) {
      await until(() => matches(match).length > 0, ms)
      const found = matches(match)
      if (found.length) throw new Error(`expected no signal, got ${JSON.stringify(found)}`)
    },
    clear() {
      signals.length = 0
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
