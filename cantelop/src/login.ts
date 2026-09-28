import type { SessionContext } from '@cantelop/sdk/session'
import { randomUUID } from 'node:crypto'
import type { Command, Event, Reply } from './contracts.js'
import { nativeLogin, type LoginLauncher, type LoginProcess } from './login-process.js'
type Context = SessionContext<Command, Event, Reply>
interface Attempt {
  id: string
  expiresAt: number
  controller: AbortController
  settled: Promise<void>
  text: string
  url?: string
  ended: boolean
  process?: LoginProcess
  waiters: Set<() => void>
}
const ANTHROPIC_HOSTS = ['claude.ai', 'claude.com', 'anthropic.com']
// Strip terminal control sequences so output is inspected as plain text.
// Native terminal output is inspected as text, never executed.
/* eslint-disable no-control-regex */
const plain = (text: string) =>
  text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
/* eslint-enable no-control-regex */
const prompts = (text: string) => plain(text).match(/paste\s+code/gi)?.length ?? 0
/** First complete HTTPS link to an Anthropic host in native login output. */
export function signInLink(text: string): string | undefined {
  for (const candidate of plain(text).match(/https:\/\/[^\s<>"']+(?=\s)/g) ?? []) {
    try {
      const url = new URL(candidate)
      if (
        !url.username &&
        !url.password &&
        ANTHROPIC_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
      )
        return url.href
    } catch {
      /* Not a URL. */
    }
  }
}
function until(attempt: Attempt, ready: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  return (async () => {
    while (!ready()) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          attempt.waiters.delete(done)
          resolve()
        }
        const timer = setTimeout(done, remaining)
        attempt.waiters.add(done)
      })
    }
    return true
  })()
}
// Runs the unmodified `claude auth login` and exposes only its sign-in link and code prompt.
// Raw terminal output stays in Session memory; it is never emitted or persisted.
export class Login {
  private attempt?: Attempt
  private settled?: Promise<void>
  constructor(
    private authenticated: () => Promise<boolean>,
    private launch: LoginLauncher = nativeLogin(),
    private timeoutMs = 10 * 60 * 1000,
    private logout: () => Promise<void> = async () => {
      throw new Error('Logout unavailable')
    },
    private waitMs = 20_000,
  ) {}
  async receive(context: Context): Promise<boolean> {
    const command = context.message.payload
    if (!command.type.startsWith('auth.')) return false
    // One deterministic auth actor per user. Agent actors cannot launch a login.
    if (!context.session.id.endsWith(':auth')) {
      context.reply({ type: 'error', code: 'auth_session_required' })
      return true
    }
    if (command.type === 'auth.check') {
      context.reply({ type: 'auth.status', authenticated: await this.authenticated() })
      return true
    }
    if (command.type === 'auth.logout') {
      await this.stop()
      await this.logout()
      context.reply({ type: 'auth.status', authenticated: false })
      return true
    }
    if (command.type === 'auth.cancel') {
      if (this.attempt?.id === command.attemptId) await this.stop()
      context.reply({ type: 'auth.cancelled', attemptId: command.attemptId })
      return true
    }
    if (command.type === 'auth.login') {
      let current = this.attempt
      if (!current) {
        await this.settled
        if (!command.force && (await this.authenticated())) {
          context.reply({ type: 'auth.status', authenticated: true })
          return true
        }
        current = this.begin(context)
      }
      await until(current, () => !!current.url || current.ended, this.waitMs)
      if (current.url) {
        context.reply({ type: 'auth.login', attemptId: current.id, url: current.url, expiresAt: current.expiresAt })
        return true
      }
      if (this.attempt === current) await this.stop()
      context.reply({ type: 'error', code: 'login_failed' })
      return true
    }
    if (command.type === 'auth.code') {
      const current = this.attempt
      if (!current || current.id !== command.attemptId || !current.url || !current.process || current.ended) {
        context.reply({ type: 'error', code: 'login_not_active' })
        return true
      }
      const before = prompts(current.text)
      try {
        await current.process.write(`${command.code}\r`)
      } catch {
        context.reply({ type: 'error', code: 'login_not_active' })
        return true
      }
      // Claude either exits after exchanging the code or asks for it again.
      if (!(await until(current, () => current.ended || prompts(current.text) > before, this.waitMs))) {
        context.reply({ type: 'error', code: 'login_timeout' })
        return true
      }
      if (!current.ended) {
        context.reply({ type: 'error', code: 'code_rejected' })
        return true
      }
      await current.settled
      if (await this.authenticated()) context.reply({ type: 'auth.status', authenticated: true })
      else context.reply({ type: 'error', code: 'login_failed' })
      return true
    }
    return true
  }
  private begin(context: Context): Attempt {
    let settled!: () => void
    const current: Attempt = (this.attempt = {
      id: randomUUID(),
      expiresAt: Date.now() + this.timeoutMs,
      controller: new AbortController(),
      settled: new Promise<void>((resolve) => {
        settled = resolve
      }),
      text: '',
      ended: false,
      waiters: new Set(),
    })
    this.settled = current.settled
    const notify = () => {
      for (const waiter of [...current.waiters]) waiter()
    }
    context.activity.start(
      async (activity) => {
        const abort = () => current.controller.abort()
        activity.signal.addEventListener('abort', abort, { once: true })
        if (activity.signal.aborted) abort()
        const timer = setTimeout(abort, this.timeoutMs)
        try {
          current.process = this.launch(current.controller.signal, async (text) => {
            current.text += text
            if (current.text.length > 64 * 1024) abort()
            current.url ??= signInLink(current.text)
            notify()
          })
          await current.process.done
        } catch {
          /* Reported through the attempt ending. */
        } finally {
          clearTimeout(timer)
          current.process?.stop()
          await current.process?.done.catch(() => {})
          activity.signal.removeEventListener('abort', abort)
          current.ended = true
          current.text = ''
          if (this.attempt === current) this.attempt = undefined
          notify()
          settled()
        }
      },
      { timeoutMs: this.timeoutMs + 30_000 },
    )
    return current
  }
  private async stop() {
    this.attempt?.controller.abort()
    await this.settled
  }
}
