import { api, ApiError } from './api'
import type { LocalAgentPreference } from '../../shared/localAgent'

export function anthropicLink(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return
    if (
      ['claude.ai', 'claude.com', 'anthropic.com'].some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    )
      return url.href
  } catch {
    /* An invalid link is never opened. */
  }
}

export interface LoginView {
  url?: string
  status: string
  ready: boolean
  active: boolean
}

export class RemoteClaudeLogin {
  private controller = new AbortController()
  private attemptId?: string
  private url?: string
  private sending = false
  constructor(
    private userId: string,
    private model: string,
    private update: (view: LoginView) => void,
    private connected: (preference: LocalAgentPreference) => void,
  ) {}
  private view(status: string) {
    if (!this.controller.signal.aborted)
      this.update({ status, url: this.url, ready: !!this.attemptId && !this.sending, active: true })
  }
  async start() {
    this.view('Starting Claude sign-in…')
    try {
      const result = await api.remoteClaudeAuth(this.userId, 'start', { model: this.model })
      this.controller.signal.throwIfAborted()
      if ('authenticated' in result && result.authenticated === true) {
        if (!result.preference) throw new Error('Doop did not confirm the Claude Plan selection.')
        this.connected(result.preference)
        return
      }
      const url = typeof result.url === 'string' ? anthropicLink(result.url) : undefined
      if (typeof result.attemptId !== 'string' || !url) throw new Error('Claude returned an invalid sign-in link.')
      this.attemptId = result.attemptId
      this.url = url
      this.view('Sign in to Claude Code, then paste the code it gives you.')
    } catch (error) {
      this.view(error instanceof Error ? error.message : 'Could not start Claude sign-in.')
    }
  }
  async send(code: string) {
    if (!this.attemptId || this.sending || !code) return
    this.sending = true
    this.view('Sending the code to Claude and confirming sign-in…')
    try {
      const result = await api.remoteClaudeAuth(this.userId, 'code', {
        attemptId: this.attemptId,
        code,
        model: this.model,
      })
      this.controller.signal.throwIfAborted()
      if (result.authenticated !== true || !result.preference) throw new Error('Claude sign-in could not be confirmed.')
      this.connected(result.preference)
    } catch (error) {
      if (error instanceof ApiError && error.body.code === 'code_rejected') {
        this.sending = false
        this.view('Claude did not accept that code. Paste it again.')
      } else {
        this.attemptId = undefined
        this.view(
          error instanceof ApiError && typeof error.body.error === 'string'
            ? error.body.error
            : error instanceof Error
              ? error.message
              : 'Could not confirm Claude sign-in.',
        )
      }
    } finally {
      this.sending = false
    }
  }
  async cancel() {
    const attemptId = this.attemptId
    this.dispose()
    if (attemptId) await api.remoteClaudeAuth(this.userId, 'cancel', { attemptId })
  }
  dispose() {
    this.controller.abort()
    this.attemptId = undefined
    this.url = undefined
  }
}
