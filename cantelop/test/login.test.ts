import test from 'node:test'
import assert from 'node:assert/strict'
import { Login, signInLink } from '../src/login.js'
import type { LoginLauncher } from '../src/login-process.js'
import type { Command, Event, Reply } from '../src/contracts.js'
import type { SessionContext, SessionActivityFunction } from '@cantelop/sdk/session'
const LINK =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=test&response_type=code&code_challenge=challenge&code_challenge_method=S256&state=state'
// Shape of `claude auth login` 2.1.267 output through the PTY helper, including its OSC 8 hyperlink.
const NATIVE_OUTPUT = `Opening browser to sign in…\r\nIf the browser didn't open, visit: \x1b]8;;${LINK}\x07${LINK}\x1b]8;;\x07\r\nPaste code here if prompted > \x1b[?25h`
type Answer = 'accept' | 'reject' | 'silent' | 'fail'
function fixture({
  timeout = 1000,
  waitMs = 500,
  signedIn = false,
  answer = 'accept' as Answer,
  output = NATIVE_OUTPUT,
} = {}) {
  const written: string[] = []
  let launches = 0,
    active = false,
    task = Promise.resolve(),
    authenticated = signedIn
  const launch: LoginLauncher = (signal, emit) => {
    launches++
    let resolve!: (code: number) => void
    const done = new Promise<number>((r) => {
      resolve = r
    })
    signal.addEventListener('abort', () => resolve(1), { once: true })
    if (signal.aborted) resolve(1)
    void (async () => {
      for (let i = 0; i < output.length; i += 40) await emit(output.slice(i, i + 40))
      if (!output.includes('Paste')) resolve(1)
    })()
    return {
      done,
      stop: () => resolve(1),
      write: async (text) => {
        written.push(text)
        if (answer === 'accept') {
          authenticated = true
          resolve(0)
        } else if (answer === 'fail') resolve(1)
        else if (answer === 'reject') await emit('Invalid code\r\nPaste code here if prompted > ')
      },
    }
  }
  const login = new Login(
    async () => authenticated,
    launch,
    timeout,
    async () => {
      authenticated = false
    },
    waitMs,
  )
  const activity = {
    get active() {
      return active
    },
    start(work: SessionActivityFunction<Command, Event>) {
      assert.equal(active, false)
      active = true
      task = Promise.resolve()
        .then(() =>
          work({
            signal: new AbortController().signal,
            output: {
              send: async () => {
                throw new Error('login must not stream')
              },
            },
            send: () => {},
          }),
        )
        .then(() => {
          active = false
        })
    },
    cancel: () => false,
    extend: () => {},
  }
  const request = async (payload: Command, id = 'tenant:auth') => {
    const replies: Reply[] = []
    await login.receive({
      session: { id, workspaceSlug: 'tenant', keepAliveSeconds: 900 },
      env: {},
      message: { id: crypto.randomUUID(), sequence: 1, payload },
      output: {
        send: async () => {
          throw new Error('login must not stream')
        },
      },
      activity,
      reply: (value: Reply) => {
        replies.push(value)
      },
      send: () => {},
      signal: new AbortController().signal,
    } as SessionContext<Command, Event, Reply>)
    assert.equal(replies.length, 1)
    return replies[0]!
  }
  const start = async () => {
    const reply = await request({ type: 'auth.login' })
    assert.equal(reply.type, 'auth.login')
    return reply as Extract<Reply, { type: 'auth.login' }>
  }
  return {
    request,
    start,
    written,
    get launches() {
      return launches
    },
    get active() {
      return active
    },
    wait: () => task,
  }
}

test('login returns the native Anthropic link, and the code completes sign-in without streaming the terminal', async () => {
  const f = fixture(),
    started = await f.start()
  assert.equal(started.url, LINK)
  assert.match(started.attemptId, /^[0-9a-f-]{36}$/)
  assert.ok(started.expiresAt > Date.now())
  assert.deepEqual(await f.request({ type: 'auth.code', attemptId: started.attemptId, code: 'abc#def' }), {
    type: 'auth.status',
    authenticated: true,
  })
  assert.deepEqual(f.written, ['abc#def\r'])
  await f.wait()
  assert.equal(f.active, false)
})

test('repeating login while an attempt is active returns that attempt without relaunching', async () => {
  const f = fixture(),
    first = await f.start()
  assert.deepEqual(await f.request({ type: 'auth.login' }), first)
  assert.deepEqual(await f.request({ type: 'auth.login', force: true }), first)
  assert.equal(f.launches, 1)
  await f.request({ type: 'auth.cancel', attemptId: first.attemptId })
})

test('login reports existing credentials unless forced', async () => {
  const f = fixture({ signedIn: true })
  assert.deepEqual(await f.request({ type: 'auth.login' }), { type: 'auth.status', authenticated: true })
  assert.equal(f.launches, 0)
  const forced = await f.request({ type: 'auth.login', force: true })
  assert.equal(forced.type, 'auth.login')
  assert.equal(f.launches, 1)
})

test('a rejected code keeps the attempt open for another try', async () => {
  const f = fixture({ answer: 'reject' }),
    { attemptId } = await f.start()
  assert.deepEqual(await f.request({ type: 'auth.code', attemptId, code: 'wrong' }), {
    type: 'error',
    code: 'code_rejected',
  })
  assert.deepEqual(await f.request({ type: 'auth.code', attemptId, code: 'wrong-again' }), {
    type: 'error',
    code: 'code_rejected',
  })
  assert.deepEqual(f.written, ['wrong\r', 'wrong-again\r'])
  await f.request({ type: 'auth.cancel', attemptId })
})

test('a code that ends Claude without credentials fails the attempt', async () => {
  const f = fixture({ answer: 'fail' }),
    { attemptId } = await f.start()
  assert.deepEqual(await f.request({ type: 'auth.code', attemptId, code: 'abc' }), {
    type: 'error',
    code: 'login_failed',
  })
  assert.deepEqual(await f.request({ type: 'auth.code', attemptId, code: 'abc' }), {
    type: 'error',
    code: 'login_not_active',
  })
})

test('a silent Claude times out the code wait but leaves the attempt running', async () => {
  const f = fixture({ answer: 'silent', waitMs: 50 }),
    { attemptId } = await f.start()
  assert.deepEqual(await f.request({ type: 'auth.code', attemptId, code: 'abc' }), {
    type: 'error',
    code: 'login_timeout',
  })
  assert.equal(f.active, true)
  await f.request({ type: 'auth.cancel', attemptId })
  assert.equal(f.active, false)
})

test('codes for unknown or stale attempts are never written to Claude', async () => {
  const f = fixture(),
    { attemptId } = await f.start()
  assert.deepEqual(await f.request({ type: 'auth.code', attemptId: crypto.randomUUID(), code: 'abc' }), {
    type: 'error',
    code: 'login_not_active',
  })
  assert.deepEqual(await f.request({ type: 'auth.cancel', attemptId }), { type: 'auth.cancelled', attemptId })
  assert.deepEqual(await f.request({ type: 'auth.code', attemptId, code: 'abc' }), {
    type: 'error',
    code: 'login_not_active',
  })
  assert.deepEqual(f.written, [])
})

test('login fails and stops Claude when no sign-in link appears', async () => {
  for (const output of ['Something went wrong\r\n', 'Paste code here if prompted > ']) {
    const f = fixture({ output, waitMs: 50 })
    assert.deepEqual(await f.request({ type: 'auth.login' }), { type: 'error', code: 'login_failed' })
    await f.wait()
    assert.equal(f.active, false)
  }
})

test('expiry ends the attempt and allows a fresh one', async () => {
  const f = fixture({ timeout: 50 }),
    { attemptId } = await f.start()
  await f.wait()
  assert.deepEqual(await f.request({ type: 'auth.code', attemptId, code: 'abc' }), {
    type: 'error',
    code: 'login_not_active',
  })
  const next = await f.start()
  assert.notEqual(next.attemptId, attemptId)
  assert.equal(f.launches, 2)
})

test('cancelling an unknown attempt is a no-op that leaves the active attempt running', async () => {
  const f = fixture(),
    { attemptId } = await f.start(),
    other = crypto.randomUUID()
  assert.deepEqual(await f.request({ type: 'auth.cancel', attemptId: other }), {
    type: 'auth.cancelled',
    attemptId: other,
  })
  assert.equal(f.active, true)
  await f.request({ type: 'auth.cancel', attemptId })
})

test('logout cancels a pending login and signs out', async () => {
  const f = fixture(),
    { attemptId } = await f.start()
  assert.deepEqual(await f.request({ type: 'auth.logout' }), { type: 'auth.status', authenticated: false })
  assert.equal(f.active, false)
  assert.deepEqual(await f.request({ type: 'auth.code', attemptId, code: 'abc' }), {
    type: 'error',
    code: 'login_not_active',
  })
})

test('agent sessions cannot invoke native login', async () => {
  const f = fixture()
  for (const command of [
    { type: 'auth.login' },
    { type: 'auth.code', attemptId: crypto.randomUUID(), code: 'abc' },
    { type: 'auth.check' },
  ] as Command[])
    assert.deepEqual(await f.request(command, 'tenant:agent'), { type: 'error', code: 'auth_session_required' })
  assert.equal(f.launches, 0)
})

test('auth status replies directly without starting a login', async () => {
  for (const signedIn of [false, true]) {
    const f = fixture({ signedIn })
    assert.deepEqual(await f.request({ type: 'auth.check' }), { type: 'auth.status', authenticated: signedIn })
    assert.equal(f.launches, 0)
  }
})

test('sign-in links are limited to complete HTTPS Anthropic URLs', () => {
  assert.equal(signInLink(NATIVE_OUTPUT), LINK)
  assert.equal(signInLink(`visit ${LINK.slice(0, 40)}`), undefined)
  for (const url of [
    'https://evil.example/claude.ai',
    'http://claude.ai/x',
    'https://user@claude.ai/x',
    'https://claude.ai.evil.example/x',
  ])
    assert.equal(signInLink(`visit ${url}\r\n`), undefined)
  assert.equal(signInLink('visit https://console.anthropic.com/oauth\r\n'), 'https://console.anthropic.com/oauth')
})
