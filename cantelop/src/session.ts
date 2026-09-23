import { defineSessionBehaviour, type SessionContext, type SessionOutput } from '@cantelop/sdk/session'
import { randomUUID } from 'node:crypto'
import { NativeAuthRequired, NativeClaude, type ClaudeRuntime } from './claude.js'
import { Login } from './login.js'
import { StateStore, type State } from './state.js'
import type { Command, Event, Message, Status, Reply } from './contracts.js'
type Context = SessionContext<Command, Event, Reply>

export function createBehaviour(runtime: ClaudeRuntime = new NativeClaude(), workspace = '/workspace') {
  const login = new Login(
    () => runtime.authenticated(),
    undefined,
    undefined,
    () => runtime.logout(),
  )
  let state: State | undefined, store: StateStore | undefined
  let active: { message: Message; controller: AbortController; outcome?: Status } | undefined
  const save = () => store!.save(state!)
  async function initialize(sessionId: string) {
    if (state) return
    store = new StateStore(workspace, sessionId)
    state = await store.load()
    // A previous Sandbox may have executed tools before disappearing. Never
    // automatically replay that running turn; retain queued work for later.
    for (const message of state.messages) if (message.status === 'running') message.status = 'interrupted'
    await save()
  }
  const status = (output: SessionOutput<Event>, message: Message) =>
    output.send({ type: 'message.status', id: message.id, status: message.status })
  function snapshot(): Extract<Reply, { type: 'session.state' }> {
    const messages = state!.messages.slice(-50).map((m) => ({ ...m, text: m.text.slice(0, 256) }))
    return {
      type: 'session.state',
      configured: !!state!.config,
      messages,
      truncated: state!.messages.length > 50 || state!.messages.some((m) => m.text.length > 256),
    }
  }
  async function start(context: Context) {
    if (context.activity.active || !state!.queue.length || !state!.config) return
    const id = state!.queue.shift()!,
      message = state!.messages.find((m) => m.id === id)!
    const controller = new AbortController()
    active = { message, controller }
    message.status = 'running'
    await save()
    context.activity.start(async (activity) => {
      const current = active!
      const abort = () => {
        current.outcome ??= 'interrupted'
        controller.abort(activity.signal.reason)
      }
      activity.signal.addEventListener('abort', abort, { once: true })
      if (activity.signal.aborted) abort()
      try {
        await status(activity.output, message)
        if (!(await runtime.authenticated())) throw new NativeAuthRequired()
        await runtime.run({
          config: state!.config!,
          conversationId: state!.conversationId,
          resume: state!.resume,
          text: message.text,
          signal: controller.signal,
          initialized: async () => {
            state!.resume = true
            await save()
          },
          emit: async (event) => {
            const json = JSON.stringify(event)
            if (Buffer.byteLength(json) < 48_000) await activity.output.send({ type: 'claude', id, event })
            else {
              const eventId = randomUUID(),
                total = Math.ceil(json.length / 8000)
              for (let index = 0; index < total; index++)
                await activity.output.send({
                  type: 'claude.fragment',
                  id,
                  eventId,
                  index,
                  total,
                  json: json.slice(index * 8000, (index + 1) * 8000),
                })
            }
          },
        })
        message.status = current.outcome ?? 'completed'
      } catch (error) {
        message.status = current.outcome ?? 'failed'
        if (!controller.signal.aborted && error instanceof NativeAuthRequired)
          await activity.output.send({ type: 'auth.required', id: message.id })
      } finally {
        activity.signal.removeEventListener('abort', abort)
        active = undefined
        await save()
        // SDK buffers this internal message until the activity fully settles.
        activity.send({ type: 'drain' })
      }
      if (!activity.signal.aborted) await status(activity.output, message)
    })
  }
  return defineSessionBehaviour<Command, Event, Reply>({
    async receive(context) {
      await initialize(context.session.id)
      const command = context.message.payload
      if (await login.receive(context)) return
      if (context.session.id.endsWith(':auth')) {
        if (command.type === 'snapshot') {
          context.reply({ type: 'error', code: 'agent_session_required' })
          return
        }
        await context.output.send({ type: 'error', code: 'agent_session_required' })
        return
      }
      if (command.type === 'snapshot') {
        context.reply(snapshot())
        return
      }
      if (command.type === 'configure') {
        if (state!.config) {
          await context.output.send({ type: 'error', code: 'already_configured' })
          return
        }
        state!.config = command.config
        await save()
        await context.output.send({ type: 'session.ready', sessionId: context.session.id })
        await context.output.send({ type: 'auth.status', authenticated: await runtime.authenticated() })
        return
      }
      if (command.type === 'drain') {
        await start(context)
        return
      }
      if (!state!.config) {
        await context.output.send({ type: 'error', code: 'session_not_configured' })
        return
      }
      if (command.type === 'cancel') {
        const message = state!.messages.find((m) => m.id === command.id)
        if (!message) {
          await context.output.send({ type: 'error', code: 'message_not_found' })
          return
        }
        if (active?.message.id === message.id) {
          active.outcome = 'cancelled'
          active.controller.abort()
        } else if (message.status === 'queued') {
          state!.queue = state!.queue.filter((id) => id !== message.id)
          message.status = 'cancelled'
          await save()
          await status(context.output, message)
        }
        return
      }
      if (command.type !== 'queue' && command.type !== 'steer') return
      const existing = state!.messages.find((m) => m.id === command.id)
      if (existing) {
        if (existing.text !== command.text) await context.output.send({ type: 'error', code: 'message_id_conflict' })
        else await status(context.output, existing)
        return
      }
      if (state!.messages.length >= 1000) {
        await context.output.send({ type: 'error', code: 'session_full' })
        return
      }
      const message: Message = { id: command.id, text: command.text, status: 'queued' }
      state!.messages.push(message)
      if (command.type === 'steer') state!.queue.unshift(message.id)
      else state!.queue.push(message.id)
      await save()
      if (command.type === 'steer' && active) {
        active.outcome = 'steered'
        active.controller.abort()
      }
      await status(context.output, message)
      await start(context)
    },
    async onRecover(context) {
      await initialize(context.session.id)
      if (context.session.id.endsWith(':auth')) {
        await context.output.send({ type: 'auth.reset' })
        return
      }
      await context.output.send(snapshot())
      // The interrupted turn stays interrupted. Queued, not-yet-started work resumes.
      context.send({ type: 'drain' })
    },
  })
}
export default createBehaviour()
