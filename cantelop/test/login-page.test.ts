import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Script } from 'node:vm'
import { generateKeyPairSync, sign } from 'node:crypto'
import { buildApi } from '@cantelop/sdk/build'
import api from '../src/api.js'
import { Login } from '../src/login.js'
import type { Command } from '../src/contracts.js'
const until = async (predicate: () => boolean) => {
  const end = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}
class Element {
  value = ''
  textContent = ''
  disabled = false
  scrollTop = 0
  scrollHeight = 100
  href = ''
  target = ''
  rel = ''
  children: Element[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Partial SDK/DOM fixtures exercise runtime boundaries without implementing the platform.
  listeners = new Map<string, (e: any) => unknown>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Partial SDK/DOM fixtures exercise runtime boundaries without implementing the platform.
  addEventListener(name: string, fn: (e: any) => unknown) {
    this.listeners.set(name, fn)
  }
  append(element: Element) {
    this.children.push(element)
  }
  replaceChildren() {
    this.children = []
  }
  focus() {}
  fire(name: string) {
    return this.listeners.get(name)?.({ preventDefault() {} })
  }
}
test('compiled login page completes encrypted native terminal flow with app bearer auth', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cantelop-page-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const artifact = await buildApi({ entrypoint: resolve('src/api.ts'), outdir: dir })
  const worker = (await import(pathToFileURL(artifact.mainModule).href)).default
  const html = await (await worker.fetch(new Request('https://app.example/login'))).text()
  const script = /<script[^>]*>([\s\S]*)<\/script>/.exec(html)![1]!
  const elements = new Map<string, Element>()
  for (const id of [
    'token',
    'input',
    'start',
    'cancel',
    'send',
    'status',
    'terminal',
    'links',
    'connect',
    'terminal-input',
  ])
    elements.set(id, new Element())
  const issuer = generateKeyPairSync('ec', { namedCurve: 'P-256' }),
    encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const claims = `${encode({ alg: 'ES256' })}.${encode({ sub: 'browser-user', iss: 'test', aud: 'test', exp: Math.floor(Date.now() / 1000) + 60 })}`
  elements.get('token')!.value =
    `${claims}.${sign('sha256', Buffer.from(claims), { key: issuer.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
  let authenticated = false,
    active = false,
    stream: ReadableStreamDefaultController<Uint8Array> | undefined,
    finish!: (code: number) => void,
    sequence = 0
  const commands: Command[] = [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Partial SDK/DOM fixtures exercise runtime boundaries without implementing the platform.
    events: any[] = [],
    written: string[] = [],
    eventRequests: Request[] = []
  const output = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Partial SDK/DOM fixtures exercise runtime boundaries without implementing the platform.
    send: async (event: any) => {
      events.push(event)
      stream?.enqueue(
        new TextEncoder().encode(`id: test:${++sequence}\ndata: ${JSON.stringify({ ...event, sequence })}\n\n`),
      )
    },
  }
  const login = new Login(
    async () => authenticated,
    (_signal, emit) => {
      const done = new Promise<number>((r) => {
        finish = r
      })
      void emit(
        'Open \x1b]8;;https://claude.ai/oauth/authorize?test=1\x1b\\https://claude.ai/oauth/authorize?test=1\x1b]8;;\x1b\\\nEnter code:',
      )
      return {
        done,
        stop: () => finish(1),
        write: async (data) => {
          written.push(data)
          authenticated = true
          finish(0)
        },
      }
    },
  )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Partial SDK/DOM fixtures exercise runtime boundaries without implementing the platform.
  const app: any = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Partial SDK/DOM fixtures exercise runtime boundaries without implementing the platform.
    workspaces: { open: async ({ slug }: any) => ({ id: 'ws', slug }) },
    sessions: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Partial SDK/DOM fixtures exercise runtime boundaries without implementing the platform.
      open: (options: any) => ({
        ...options,
        request: async (payload: Command) => {
          let reply: unknown
          commands.push(payload)
          await login.receive({
            session: options,
            env: {},
            message: { id: crypto.randomUUID(), sequence: 1, payload },
            output,
            reply: (value) => {
              reply = value
            },
            signal: new AbortController().signal,
            send: () => {},
            activity: {
              active: false,
              start: () => {
                throw new Error('status must not start login')
              },
              cancel: () => false,
              extend: () => {},
            },
          })
          assert.deepEqual(reply, { type: 'auth.status', authenticated: false })
          return reply
        },
        dispatch: async (payload: Command) => {
          commands.push(payload)
          await login.receive({
            session: options,
            env: {},
            message: { id: crypto.randomUUID(), sequence: 1, payload },
            output,
            signal: new AbortController().signal,
            send: () => {},
            activity: {
              get active() {
                return active
              },
              start: (work) => {
                active = true
                void Promise.resolve()
                  .then(() => work({ signal: new AbortController().signal, output, send: () => {} }))
                  .finally(() => {
                    active = false
                  })
              },
              cancel: () => false,
              extend: () => {},
            },
          })
          return { id: 'receipt' }
        },
        events: async (request: Request) => {
          eventRequests.push(request)
          return new Response(
            new ReadableStream({
              start(controller) {
                stream = controller
              },
              cancel() {
                stream = undefined
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          )
        },
      }),
    },
  }
  const router = api.create({
    app,
    env: {
      AUTH_PUBLIC_JWK: JSON.stringify(issuer.publicKey.export({ format: 'jwk' })),
      AUTH_ISSUER: 'test',
      AUTH_AUDIENCE: 'test',
    },
  })
  const timers = new Set<ReturnType<typeof setTimeout>>()
  t.after(() => {
    for (const timer of timers) clearTimeout(timer)
  })
  new Script(script).runInNewContext({
    crypto,
    clearTimeout,
    TextEncoder,
    TextDecoder,
    URL,
    AbortController,
    btoa,
    atob,
    document: { getElementById: (id: string) => elements.get(id), createElement: () => new Element() },
    window: { addEventListener: () => {} },
    setTimeout: (fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms)
      timers.add(timer)
      return timer
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Partial SDK/DOM fixtures exercise runtime boundaries without implementing the platform.
    fetch: (path: string, init: any) => router.handle(new Request(new URL(path, 'https://app.example'), init)),
  })
  await elements.get('connect')!.fire('submit')
  await until(() => elements.get('terminal')!.textContent.includes('Enter code:'))
  assert.equal(elements.get('links')!.children[0]?.href, 'https://claude.ai/oauth/authorize?test=1')
  stream!.close()
  stream = undefined
  await until(() => eventRequests.length === 2)
  assert.match(eventRequests[1]!.headers.get('Last-Event-ID')!, /^test:/)
  elements.get('input')!.value = 'PRIVATE-CODE'
  await elements.get('terminal-input')!.fire('submit')
  await until(() => elements.get('status')!.textContent.includes('Claude is connected'))
  assert.deepEqual(written, ['PRIVATE-CODE\r'])
  assert.equal(elements.get('input')!.value, '')
  assert.equal(elements.get('token')!.value, '')
  assert.ok(!JSON.stringify(commands).includes('PRIVATE-CODE'))
  assert.ok(!JSON.stringify(events).includes('PRIVATE-CODE'))
  assert.equal(elements.get('send')!.disabled, true)
})
