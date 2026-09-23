import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBehaviour } from '../src/session.js'
import { StateStore } from '../src/state.js'
import { NativeAuthRequired, type ClaudeRuntime, type Turn } from '../src/claude.js'
import type { Command, Event, Reply } from '../src/contracts.js'
import type { SessionContext, SessionActivityFunction } from '@cantelop/sdk/session'
class FakeClaude implements ClaudeRuntime {
  signedIn = true
  runs: { turn: Turn; resolve(): void; reject(e: Error): void }[] = []
  async logout() {
    this.signedIn = false
  }
  async authenticated() {
    return this.signedIn
  }
  async run(turn: Turn) {
    await turn.initialized()
    return new Promise<void>((resolve, reject) => {
      this.runs.push({ turn, resolve, reject })
      turn.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      if (turn.signal.aborted) reject(new Error('aborted'))
    })
  }
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}
function harness(runtime: FakeClaude, root: string) {
  const behaviour = createBehaviour(runtime, root),
    events: Event[] = []
  const replies: Reply[] = []
  let activityActive = false,
    activityTask = Promise.resolve(),
    mailbox = Promise.resolve()
  const output = {
    send: async (event: Event) => {
      events.push(event)
    },
  }
  const send = (command: Command) => {
    mailbox = mailbox.then(() =>
      behaviour.receive({
        signal: new AbortController().signal,
        session: { id: 'session-a', workspaceSlug: 'user', keepAliveSeconds: 300 },
        env: {},
        message: { id: crypto.randomUUID(), sequence: 1, payload: command },
        output,
        reply: (value) => {
          replies.push(value)
        },
        send: (command) => {
          void send(command)
        },
        activity,
      } satisfies SessionContext<Command, Event, Reply>),
    )
    return mailbox
  }
  const activity = {
    get active() {
      return activityActive
    },
    start(work: SessionActivityFunction<Command, Event>) {
      assert.equal(activityActive, false)
      activityActive = true
      const pending: Command[] = []
      activityTask = Promise.resolve()
        .then(() =>
          work({
            signal: new AbortController().signal,
            output,
            send: (m) => {
              pending.push(m)
            },
          }),
        )
        .then(() => {
          activityActive = false
          for (const m of pending) void send(m)
        })
    },
    cancel: () => false,
    extend: () => {},
  }
  return {
    send,
    events,
    replies,
    behaviour,
    idle: async () => {
      await until(() => !activityActive)
      await activityTask
      await mailbox
    },
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Partial SDK/DOM fixtures exercise runtime boundaries without implementing the platform.
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'cantelop-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = new FakeClaude(),
    h = harness(runtime, root)
  await h.send({
    type: 'configure',
    config: {
      tools: ['Read'],
      allowedTools: [],
      mcps: {},
      model: 'sonnet',
      systemPrompt: 'Persisted rules',
      maxTurns: 24,
    },
  })
  return { root, runtime, h }
}
test('managed activity keeps mailbox responsive; steering precedes FIFO queue and resumes conversation', async (t) => {
  const { runtime, h } = await fixture(t)
  await h.send({ type: 'queue', id: 'a', text: 'a' })
  await until(() => runtime.runs.length === 1)
  await h.send({ type: 'queue', id: 'b', text: 'b' })
  await h.send({ type: 'steer', id: 'c', text: 'c' })
  await until(() => runtime.runs.length === 2)
  assert.deepEqual(
    runtime.runs.map((r) => r.turn.text),
    ['a', 'c'],
  )
  assert.equal(runtime.runs[1]!.turn.resume, true)
  assert.equal(runtime.runs[1]!.turn.conversationId, runtime.runs[0]!.turn.conversationId)
  runtime.runs[1]!.resolve()
  await until(() => runtime.runs.length === 3)
  assert.equal(runtime.runs[2]!.turn.text, 'b')
  runtime.runs[2]!.resolve()
  await h.idle()
  assert.ok(h.events.some((e) => e.type === 'message.status' && e.id === 'a' && e.status === 'steered'))
})
test('queued cancellation, duplicate IDs and active cancellation', async (t) => {
  const { runtime, h } = await fixture(t)
  await h.send({ type: 'queue', id: 'a', text: 'a' })
  await until(() => runtime.runs.length === 1)
  await h.send({ type: 'queue', id: 'b', text: 'b' })
  await h.send({ type: 'cancel', id: 'b' })
  await h.send({ type: 'queue', id: 'a', text: 'a' })
  await h.send({ type: 'cancel', id: 'a' })
  await h.idle()
  assert.equal(runtime.runs.length, 1)
  for (const id of ['a', 'b'])
    assert.ok(h.events.some((e) => e.type === 'message.status' && e.id === id && e.status === 'cancelled'))
})
test('durable configuration survives reactivation; interrupted work is not replayed', async (t) => {
  const { root, runtime } = await fixture(t)
  const store = new StateStore(root, 'session-a'),
    state = await store.load()
  state.resume = true
  state.messages.push({ id: 'old', text: 'possibly ran tools', status: 'running' })
  await store.save(state)
  const replacement = harness(runtime, root)
  await replacement.send({ type: 'snapshot' })
  const snapshot = replacement.replies.find((e) => e.type === 'session.state')
  assert.ok(snapshot?.type === 'session.state')
  assert.equal(snapshot.messages[0]?.status, 'interrupted')
  assert.equal(runtime.runs.length, 0)
  await replacement.send({ type: 'queue', id: 'new', text: 'next' })
  await until(() => runtime.runs.length === 1)
  assert.equal(runtime.runs[0]!.turn.resume, true)
  assert.deepEqual(runtime.runs[0]!.turn.config, state.config)
  assert.equal(runtime.runs[0]!.turn.config.systemPrompt, 'Persisted rules')
  runtime.runs[0]!.resolve()
  await replacement.idle()
})
test('unauthenticated native runtime fails turn without starting Claude', async (t) => {
  const { runtime, h } = await fixture(t)
  runtime.signedIn = false
  await h.send({ type: 'auth.check' })
  await h.send({ type: 'queue', id: 'a', text: 'a' })
  await h.idle()
  assert.equal(runtime.runs.length, 0)
  assert.ok(h.replies.some((e) => e.type === 'error' && e.code === 'auth_session_required'))
  assert.ok(h.events.some((e) => e.type === 'message.status' && e.status === 'failed'))
})
test('large Claude events are fragmented within SDK output size limit', async (t) => {
  const { runtime, h } = await fixture(t)
  await h.send({ type: 'queue', id: 'a', text: 'a' })
  await until(() => runtime.runs.length === 1)
  const original = { text: '😀'.repeat(40000) }
  await runtime.runs[0]!.turn.emit(original)
  const fragments = h.events.filter((e) => e.type === 'claude.fragment')
  assert.ok(fragments.length > 1)
  assert.deepEqual(JSON.parse(fragments.map((e) => e.json).join('')), original)
  assert.ok(fragments.every((e) => Buffer.byteLength(JSON.stringify(e)) < 64000))
  runtime.runs[0]!.resolve()
  await h.idle()
})
test('SDK recovery restarts only pending work and preserves interrupted status', async (t) => {
  const { root, runtime } = await fixture(t)
  const store = new StateStore(root, 'session-a'),
    state = await store.load()
  state.messages.push(
    { id: 'running', text: 'already attempted', status: 'running' },
    { id: 'pending', text: 'not started', status: 'queued' },
  )
  state.queue = ['pending']
  await store.save(state)
  const replacement = harness(runtime, root)
  await replacement.behaviour.onRecover!({
    signal: new AbortController().signal,
    recovery: { id: 'recovery', interruptedMessageId: 'platform-id' },
    session: { id: 'session-a', workspaceSlug: 'user', keepAliveSeconds: 300 },
    env: {},
    output: {
      send: async (e) => {
        replacement.events.push(e)
      },
    },
    send: (m) => {
      void replacement.send(m)
    },
    activity: {
      active: false,
      start: () => {
        throw new Error('must dispatch drain')
      },
      cancel: () => false,
      extend: () => {},
    },
  })
  await until(() => runtime.runs.length === 1)
  assert.equal(runtime.runs[0]!.turn.text, 'not started')
  runtime.runs[0]!.resolve()
  await replacement.idle()
  assert.equal((await store.load()).messages.find((m) => m.id === 'running')?.status, 'interrupted')
})
test('auth Sandbox recovery requests a fresh handshake instead of replaying login', async (t) => {
  const { root, runtime } = await fixture(t),
    events: Event[] = []
  await createBehaviour(runtime, root).onRecover!({
    signal: new AbortController().signal,
    recovery: { id: 'recovery', interruptedMessageId: 'login' },
    session: { id: 'tenant:auth', workspaceSlug: 'user', keepAliveSeconds: 300 },
    env: {},
    output: {
      send: async (e) => {
        events.push(e)
      },
    },
    send: () => {
      throw new Error('must not replay auth')
    },
    activity: {
      active: false,
      start: () => {
        throw new Error('must not restart login')
      },
      cancel: () => false,
      extend: () => {},
    },
  })
  assert.deepEqual(events, [{ type: 'auth.reset' }])
  assert.equal(runtime.runs.length, 0)
})

test('terminal native auth failure emits auth.required for the affected message', async (t) => {
  const { runtime, h } = await fixture(t)
  await h.send({ type: 'configure', config: { tools: [], allowedTools: [], mcps: {} } })
  const id = crypto.randomUUID()
  await h.send({ type: 'queue', id, text: 'test' })
  await until(() => runtime.runs.length === 1)
  runtime.runs[0]!.reject(new NativeAuthRequired())
  await until(() => h.events.some((e) => e.type === 'auth.required'))
  assert.ok(h.events.some((e) => e.type === 'auth.required' && e.id === id))
})
