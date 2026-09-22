import test from 'node:test'
import assert from 'node:assert/strict'
import { Login } from '../src/login.js'
import { terminalCrypto } from '../src/terminal-crypto.js'
import type { LoginLauncher } from '../src/login-process.js'
import type { Command, Event, Reply } from '../src/contracts.js'
import type { SessionContext, SessionActivityFunction } from '@cantelop/sdk/session'
const cryptoBox = terminalCrypto()
const until = async (predicate: () => boolean) => {
  const end = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}
async function fixture(timeout = 1000) {
  const browser = await cryptoBox.generate(),
    attemptId = crypto.randomUUID(),
    events: Event[] = [],
    written: string[] = []
  let signedIn = false,
    launches = 0,
    active = false,
    resolve!: (code: number) => void,
    task = Promise.resolve()
  const output = {
    send: async (event: Event) => {
      events.push(event)
    },
  }
  let nativeOutput!: (text: string) => Promise<void>
  const launch: LoginLauncher = (signal, emit) => {
    launches++
    nativeOutput = emit
    const done = new Promise<number>((r) => {
      resolve = r
    })
    signal.addEventListener('abort', () => resolve(1), { once: true })
    if (signal.aborted) resolve(1)
    return {
      done,
      write: async (text) => {
        written.push(text)
      },
      stop: () => resolve(1),
    }
  }
  const replies: Reply[] = []
  const login = new Login(
    async () => signedIn,
    launch,
    timeout,
    async () => {
      signedIn = false
    },
  )
  const activity = {
    get active() {
      return active
    },
    start(work: SessionActivityFunction<Command, Event>) {
      assert.equal(active, false)
      active = true
      task = Promise.resolve()
        .then(() => work({ signal: new AbortController().signal, output, send: () => {} }))
        .then(() => {
          active = false
        })
    },
    cancel: () => false,
    extend: () => {},
  }
  const dispatch = (payload: Command, id = 'tenant:auth') =>
    login.receive({
      session: { id, workspaceSlug: 'tenant', keepAliveSeconds: 300 },
      env: {},
      message: { id: crypto.randomUUID(), sequence: 1, payload },
      output,
      activity,
      reply: (value: Reply) => {
        replies.push(value)
      },
      send: () => {},
      signal: new AbortController().signal,
    } as SessionContext<Command, Event, Reply>)
  await dispatch({ type: 'auth.start', attemptId, publicKey: browser.publicKey })
  await until(() => launches === 1)
  const started = events.find((e) => e.type === 'auth.started')
  assert.ok(started?.type === 'auth.started')
  const key = await cryptoBox.derive(browser.privateKey, started.publicKey)
  return {
    dispatch,
    attemptId,
    browser,
    events,
    written,
    key,
    replies,
    get launches() {
      return launches
    },
    output: async (text: string) => nativeOutput(text),
    finish: async () => {
      signedIn = true
      resolve(0)
      await task
    },
    stop: async () => {
      await dispatch({ type: 'auth.cancel', attemptId })
      await task
    },
    wait: () => task,
  }
}
test('native terminal traffic is encrypted; input is ordered and retry-safe', async () => {
  const f = await fixture()
  const frame = await cryptoBox.seal(f.key, 'private-login-code\r', `${f.attemptId}:input:1`)
  const command: Command = { type: 'auth.input', attemptId: f.attemptId, sequence: 1, ...frame }
  await f.dispatch(command)
  await f.dispatch(command)
  assert.deepEqual(f.written, ['private-login-code\r'])
  await f.output('native response with private-login-code')
  const event = f.events.find((e) => e.type === 'auth.output')
  assert.ok(event?.type === 'auth.output')
  assert.equal(
    await cryptoBox.open(f.key, event, `${f.attemptId}:output:${event.terminalSequence}`),
    'native response with private-login-code',
  )
  assert.ok(!JSON.stringify(f.events).includes('private-login-code'))
  assert.ok(!JSON.stringify(command).includes('private-login-code'))
  await f.finish()
  assert.ok(f.events.some((e) => e.type === 'auth.finished' && e.authenticated && e.outcome === 'succeeded'))
})
test('reconnect does not start another process; competing and stale attempts cannot write', async () => {
  const f = await fixture()
  await f.dispatch({ type: 'auth.start', attemptId: f.attemptId, publicKey: f.browser.publicKey })
  assert.equal(f.launches, 1)
  await f.dispatch({ type: 'auth.start', attemptId: crypto.randomUUID(), publicKey: f.browser.publicKey })
  assert.ok(f.events.some((e) => e.type === 'auth.error' && e.code === 'login_busy'))
  const frame = await cryptoBox.seal(f.key, 'bad', `${f.attemptId}:input:1`)
  await f.dispatch({ type: 'auth.input', attemptId: crypto.randomUUID(), sequence: 1, ...frame })
  await f.dispatch({ type: 'auth.input', attemptId: f.attemptId, sequence: 2, ...frame })
  assert.equal(f.written.length, 0)
  await f.stop()
  await f.dispatch({ type: 'auth.start', attemptId: f.attemptId, publicKey: f.browser.publicKey })
  assert.equal(f.launches, 1)
})
test('ciphertext is bound to the attempt, direction, and sequence', async () => {
  const f = await fixture()
  const frame = await cryptoBox.seal(f.key, 'no', `${f.attemptId}:output:1`)
  await f.dispatch({ type: 'auth.input', attemptId: f.attemptId, sequence: 1, ...frame })
  assert.equal(f.written.length, 0)
  assert.ok(f.events.some((e) => e.type === 'auth.error' && e.code === 'input_rejected'))
  await f.stop()
})
test('expiry cancels native process and allows a fresh attempt', async () => {
  const f = await fixture(50)
  await f.wait()
  assert.ok(f.events.some((e) => e.type === 'auth.finished' && e.outcome === 'expired'))
  const id = crypto.randomUUID()
  await f.dispatch({ type: 'auth.start', attemptId: id, publicKey: f.browser.publicKey })
  await until(() => f.launches === 2)
  await f.dispatch({ type: 'auth.cancel', attemptId: id })
  await f.wait()
})
test('agent sessions cannot invoke native login or accept terminal input', async () => {
  const f = await fixture()
  await f.dispatch(
    { type: 'auth.start', attemptId: crypto.randomUUID(), publicKey: f.browser.publicKey },
    'tenant:agent',
  )
  assert.equal(f.launches, 1)
  assert.ok(f.events.some((e) => e.type === 'error' && e.code === 'auth_session_required'))
  await f.stop()
})

test('forced reconnect opens the native login even when saved credentials appear signed in', async () => {
  const f = await fixture()
  await f.finish()
  const next = crypto.randomUUID()
  await f.dispatch({ type: 'auth.start', attemptId: next, publicKey: f.browser.publicKey, force: true })
  await until(() => f.launches === 2)
  await f.dispatch({ type: 'auth.cancel', attemptId: next })
  await f.wait()
})

test('auth status uses one direct reply and does not emit an event or start interactive login', async () => {
  for (const authenticated of [false, true]) {
    const replies: Reply[] = []
    const login = new Login(
      async () => authenticated,
      () => {
        throw new Error('must not launch login')
      },
    )
    await login.receive({
      session: { id: 'tenant:auth', workspaceSlug: 'tenant', keepAliveSeconds: 900 },
      env: {},
      message: { id: crypto.randomUUID(), sequence: 1, payload: { type: 'auth.check' } },
      signal: new AbortController().signal,
      reply: (value) => {
        replies.push(value)
      },
      send: () => {},
      output: {
        send: async () => {
          throw new Error('status must not be streamed')
        },
      },
      activity: {
        active: false,
        start: () => {
          throw new Error('must not start an activity')
        },
        cancel: () => false,
        extend: () => {},
      },
    })
    assert.deepEqual(replies, [{ type: 'auth.status', authenticated }])
  }
})

test('logout cancels pending login and requires a new native login', async () => {
  const f = await fixture()
  await f.dispatch({ type: 'auth.logout' })
  await f.wait()
  assert.deepEqual(f.replies, [{ type: 'auth.status', authenticated: false }])
  assert.ok(f.events.some((e) => e.type === 'auth.finished' && e.outcome === 'cancelled'))
  await f.dispatch({ type: 'auth.start', attemptId: crypto.randomUUID(), publicKey: f.browser.publicKey })
  await until(() => f.launches === 2)
  await f.dispatch({ type: 'auth.logout' })
  await f.wait()
})
test('logout clears completed login replay and saved authentication', async () => {
  const f = await fixture()
  await f.finish()
  await f.dispatch({ type: 'auth.logout' })
  await f.dispatch({ type: 'auth.start', attemptId: f.attemptId, publicKey: f.browser.publicKey })
  await until(() => f.launches === 2)
  await f.stop()
})
