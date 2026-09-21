import { afterEach, expect, it, vi } from 'vitest'
import { terminalCrypto } from '../src/lib/claudeTerminalCrypto'
const mocks = vi.hoisted(() => ({ auth: vi.fn() }))
vi.mock('../src/lib/api', () => ({ api: { remoteClaudeAuth: mocks.auth } }))
import { RemoteClaudeLogin, anthropicLinks, cleanTerminal, type LoginView } from '../src/lib/remoteClaudeLogin'
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
it('uses an encrypted native login with ordered output, encrypted input, and no application bearer token in the browser', async () => {
  const crypto = terminalCrypto(),
    serverPair = await crypto.generate()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let key!: CryptoKey
  let attemptId = ''
  let decrypted = ''
  const emit = (event: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
  const fetcher = vi.fn(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            controller = c
          },
        }),
      ),
  )
  vi.stubGlobal('fetch', fetcher)
  mocks.auth.mockImplementation(async (userId: string, action: string, body: Record<string, unknown>) => {
    expect(userId).toBe('alice')
    if (action === 'start' && body.publicKey) {
      attemptId = String(body.attemptId)
      key = await crypto.derive(serverPair.privateKey, body.publicKey as JsonWebKey)
      emit({ type: 'auth.started', attemptId, publicKey: serverPair.publicKey, expiresAt: Date.now() + 60000 })
      const frame = await crypto.seal(key, 'Visit https://claude.ai/login', `${attemptId}:output:1`)
      emit({ type: 'auth.output', attemptId, terminalSequence: 1, ...frame })
    }
    if (action === 'input') {
      expect(body).not.toHaveProperty('code')
      decrypted = await crypto.open(key, body as { iv: string; data: string }, `${attemptId}:input:1`)
      emit({ type: 'auth.finished', attemptId, authenticated: true, outcome: 'succeeded' })
    }
    return { sessionId: 'alice:auth' }
  })
  const views: LoginView[] = []
  const connected = vi.fn(async () => {})
  const login = new RemoteClaudeLogin('alice', (view) => views.push(view), connected)
  try {
    await login.start()
    await vi.waitFor(() => expect(views.at(-1)?.text).toContain('https://claude.ai/login'))
    expect(views.at(-1)?.ready).toBe(true)
    await login.send('private-code')
    await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce())
    expect(decrypted).toBe('private-code\r')
    expect(JSON.stringify(mocks.auth.mock.calls)).not.toContain('private-code')
    expect(fetcher).toHaveBeenCalledWith(
      '/api/remote-claude/events',
      expect.objectContaining({ headers: { 'X-Doop-User': 'alice' } }),
    )
  } finally {
    login.dispose()
  }
})
it('offers links only to Anthropic HTTPS hosts and strips terminal control sequences', () => {
  const text =
    'https://claude.ai/login https://claude.ai.evil.test/login https://claude.com@evil.test https://auth.anthropic.com/oauth http://claude.ai'
  expect(anthropicLinks(text)).toEqual(['https://claude.ai/login', 'https://auth.anthropic.com/oauth'])
  expect(cleanTerminal('\u001b[31mHello\u001b[0m')).toBe('Hello')
})
