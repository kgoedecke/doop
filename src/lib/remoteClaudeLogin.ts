import { consumeClaudeEvents, type ClaudeEvent } from '../../shared/remoteClaude'
import { terminalCrypto } from './claudeTerminalCrypto'
import { api } from './api'

export function cleanTerminal(text: string) {
  // Native terminal text is never interpreted as HTML or terminal controls.
  /* eslint-disable no-control-regex */
  return text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  /* eslint-enable no-control-regex */
}
export function anthropicLinks(text: string) {
  return [
    ...new Set(
      (text.match(/https:\/\/[^\s<>"']+/g) ?? []).filter((candidate) => {
        try {
          const url = new URL(candidate)
          return (
            !url.username &&
            !url.password &&
            ['claude.ai', 'claude.com', 'anthropic.com'].some(
              (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
            )
          )
        } catch {
          return false
        }
      }),
    ),
  ]
}

export interface LoginView {
  text: string
  status: string
  ready: boolean
  active: boolean
}
export class RemoteClaudeLogin {
  private transport = terminalCrypto()
  private controller = new AbortController()
  private attemptId = crypto.randomUUID()
  private activeAttemptId: string = this.attemptId
  private key?: CryptoKey
  private pair?: Awaited<ReturnType<ReturnType<typeof terminalCrypto>['generate']>>
  private outputSequence = 0
  private inputSequence = 0
  private sending = false
  private text = ''
  private finished = false
  private expiresAt = Date.now() + 10 * 60_000
  constructor(
    private userId: string,
    private update: (view: LoginView) => void,
    private connected: (attemptId: string) => Promise<void>,
  ) {}
  private view(status: string) {
    if (!this.controller.signal.aborted)
      this.update({
        text: cleanTerminal(this.text),
        status,
        ready: !!this.key && !this.sending && !this.finished,
        active: !this.finished,
      })
  }
  async start(force = false) {
    let slowStart: ReturnType<typeof setTimeout> | undefined
    try {
      this.view('Preparing secure sign-in…')
      this.pair = await this.transport.generate()
      this.controller.signal.throwIfAborted()
      // Opening the SDK event stream provisions the workspace. Subscribe before
      // dispatching login, without first running a redundant native auth check.
      this.view('Connecting to your hosted workspace…')
      slowStart = setTimeout(() => {
        this.view('Your hosted workspace is taking a moment to start. The sign-in button will appear when it’s ready.')
      }, 6000)
      let opened!: () => void
      let failed!: (error: unknown) => void
      const ready = new Promise<void>((resolve, reject) => {
        opened = resolve
        failed = reject
      })
      const stream = this.subscribe(opened).catch((error: unknown) => {
        failed(error)
        if (!this.controller.signal.aborted) {
          this.key = undefined
          this.view(error instanceof Error ? error.message : 'Login stream interrupted. Cancel and retry.')
        }
      })
      void stream
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          ready,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Login stream timed out. Cancel and retry.')), 30_000)
          }),
        ])
      } finally {
        clearTimeout(timer)
        clearTimeout(slowStart)
      }
      this.controller.signal.throwIfAborted()
      this.view('Starting Claude sign-in…')
      await api.remoteClaudeAuth(this.userId, 'start', {
        attemptId: this.attemptId,
        publicKey: this.pair.publicKey,
        ...(force ? { force: true } : {}),
      })
    } catch (error) {
      this.key = undefined
      this.view(error instanceof Error ? error.message : 'Could not open login. Cancel and retry.')
    } finally {
      clearTimeout(slowStart)
    }
  }
  private async event(event: ClaudeEvent) {
    if (
      ['auth.reset', 'event_stream_reset', 'event_cursor_expired'].includes(event.type) ||
      (event.type === 'error' && ['event_stream_reset', 'event_cursor_expired'].includes(event.code))
    )
      throw new Error('Login terminal reset. Cancel and start again.')
    if (!('attemptId' in event) || event.attemptId !== this.attemptId) return
    if (event.type === 'auth.started') {
      this.key = await this.transport.derive(this.pair!.privateKey, event.publicKey)
      this.expiresAt = event.expiresAt
      this.view('Preparing your Claude sign-in link…')
    } else if (event.type === 'auth.output') {
      if (event.terminalSequence <= this.outputSequence) return
      if (!this.key || event.terminalSequence !== this.outputSequence + 1)
        throw new Error('Login output was lost. Cancel and restart.')
      this.text = (
        this.text + (await this.transport.open(this.key, event, `${this.attemptId}:output:${event.terminalSequence}`))
      ).slice(-64 * 1024)
      this.outputSequence = event.terminalSequence
      this.view('Sign in to Claude in a new tab, then return here.')
    } else if (event.type === 'auth.finished') {
      this.finished = true
      this.key = undefined
      this.pair = undefined
      this.view(
        event.authenticated && event.outcome === 'succeeded'
          ? 'Claude connected. Enabling hosted execution…'
          : `Login ${event.outcome}. Cancel and try again.`,
      )
      this.controller.abort()
      if (event.authenticated && event.outcome === 'succeeded') await this.connected(this.attemptId)
    } else if (event.type === 'auth.error') {
      if (event.activeAttemptId) this.activeAttemptId = event.activeAttemptId
      throw new Error(
        event.code === 'login_busy'
          ? 'Another login attempt is active. Cancel it before starting again.'
          : 'Native login failed. Cancel and retry.',
      )
    }
  }
  private async subscribe(opened: () => void) {
    let cursor = ''
    while (!this.controller.signal.aborted && !this.finished) {
      let response: Response
      try {
        response = await fetch('/api/remote-claude/events', {
          headers: { 'X-Doop-User': this.userId, ...(cursor ? { 'Last-Event-ID': cursor } : {}) },
          signal: this.controller.signal,
          cache: 'no-store',
        })
      } catch {
        if (this.controller.signal.aborted) return
        if (Date.now() > this.expiresAt) throw new Error('Login expired. Cancel and start again.')
        await new Promise((resolve) => setTimeout(resolve, 1000))
        continue
      }
      if (!response.ok) throw new Error('Login stream unavailable. Cancel and reconnect.')
      opened()
      let eventError: unknown
      try {
        await consumeClaudeEvents(
          response,
          async (event) => {
            try {
              await this.event(event)
            } catch (error) {
              eventError = error
              throw error
            }
          },
          (id) => {
            cursor = id
          },
          this.controller.signal,
        )
      } catch (error) {
        if (eventError) throw eventError
        if (this.controller.signal.aborted) return
        if (!(error instanceof TypeError)) throw error
      }
      if (Date.now() > this.expiresAt) throw new Error('Login expired. Cancel and start again.')
      if (!this.finished) await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  async send(text: string) {
    if (!this.key || this.sending || this.finished) return
    this.sending = true
    this.view('Verifying sign-in…')
    try {
      const sequence = this.inputSequence + 1
      const frame = await this.transport.seal(this.key, text + '\r', `${this.attemptId}:input:${sequence}`)
      await api.remoteClaudeAuth(this.userId, 'input', { attemptId: this.attemptId, sequence, ...frame })
      this.inputSequence = sequence
      this.sending = false
      this.view('Verifying sign-in…')
    } catch {
      this.key = undefined
      this.sending = false
      this.view('Input delivery interrupted. Cancel and restart the login.')
    }
  }
  async cancel() {
    this.dispose()
    await api.remoteClaudeAuth(this.userId, 'cancel', { attemptId: this.activeAttemptId })
  }
  dispose() {
    this.controller.abort()
    this.key = undefined
    this.pair = undefined
    this.text = ''
  }
}
