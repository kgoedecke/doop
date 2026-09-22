import { useEffect, useRef, useState } from 'react'
import { authClient } from '../lib/auth'
import { api, ApiError } from '../lib/api'
import { useLocalAgent } from '../lib/localAgent'
import { useStore } from '../lib/store'
import { RemoteClaudeLogin, anthropicLinks, type LoginView } from '../lib/remoteClaudeLogin'
import { CLAUDE_MODELS, normalizeClaudeModel } from '../../shared/localAgent'
import type { RemoteClaudeStatus } from '../../shared/remoteClaude'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { ToggleChipGroup, ToggleChipItem } from './ui/toggle-chip'
import { planRow, planMark, planPill, actionsRow } from './ui/model-plan'

export function RemoteClaudeRow() {
  const { data: session } = authClient.useSession()
  return session?.user.id ? <RemoteClaudeConnection key={session.user.id} userId={session.user.id} /> : null
}

function RemoteClaudeConnection({ userId }: { userId: string }) {
  const preference = useLocalAgent((state) => state.preference)
  const [status, setStatus] = useState<RemoteClaudeStatus | null>(null)
  const [view, setView] = useState<LoginView | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const login = useRef<RemoteClaudeLogin>()
  const active = !!preference?.enabled && preference.transport === 'remote'
  const needsReconnect = active && !!status?.authRequired
  const model = normalizeClaudeModel(preference?.model)
  const signInUrl = view ? anthropicLinks(view.text).at(-1) : undefined
  const codeRequested = !!view && /(?:paste|enter)[^\n]{0,50}\bcode\b/i.test(view.text)
  useEffect(() => {
    let disposed = false
    const refresh = () => {
      void api.remoteClaude(userId).then(
        (next) => {
          if (!disposed) setStatus(next)
        },
        () => {},
      )
    }
    refresh()
    const interval = setInterval(refresh, 10_000)
    window.addEventListener('focus', refresh)
    return () => {
      disposed = true
      clearInterval(interval)
      window.removeEventListener('focus', refresh)
      login.current?.dispose()
      login.current = undefined
    }
  }, [userId])
  async function act(fn: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(
        e instanceof ApiError && typeof e.body.error === 'string'
          ? e.body.error
          : e instanceof Error
            ? e.message
            : 'Could not update hosted execution.',
      )
    } finally {
      setBusy(false)
    }
  }
  async function select(selected = model, loginAttemptId?: string) {
    const saved = await api.selectRemoteClaude(userId, selected, loginAttemptId)
    useLocalAgent.setState({ preference: saved })
    useStore.getState().allowanceChanged()
    setStatus(await api.remoteClaude(userId))
    setView(null)
  }
  async function connect() {
    if (active && !status?.authRequired && (await api.checkRemoteClaude(userId)).authenticated) {
      await select()
      return
    }
    login.current?.dispose()
    const connection = new RemoteClaudeLogin(userId, setView, (attemptId) => act(() => select(model, attemptId)))
    login.current = connection
    await connection.start(status?.authRequired ?? false)
  }
  if (!status?.configured) return null
  return (
    <section className={planRow(active)} aria-label="Hosted execution">
      <span aria-hidden className={planMark(active)}>
        ☁
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-display text-[18px] font-extrabold tracking-[-0.02em]">Hosted execution</h3>
          <span className={planPill(active)}>
            {needsReconnect ? 'Sign-in required' : active ? 'Claude connected' : 'Available'}
          </span>
        </div>
        <p className="mt-1.5 text-[14px] leading-[1.55] text-ink-soft">
          Run Claude Code with your own account in a private hosted workspace. Tasks continue when you close Doop.
        </p>
        {needsReconnect && (
          <p className="mt-2 text-sm text-ink-soft">
            Connect Claude to resume hosted tasks. You can retry interrupted tasks after signing in.
          </p>
        )}
        <div className={actionsRow}>
          {active && (
            <ToggleChipGroup
              aria-label="Hosted model"
              value={model}
              disabled={busy || !!view}
              onValueChange={(next) => {
                void act(() => select(normalizeClaudeModel(next)))
              }}
            >
              {CLAUDE_MODELS.map((option) => (
                <ToggleChipItem key={option.id} value={option.id} title={option.blurb}>
                  {option.name}
                </ToggleChipItem>
              ))}
            </ToggleChipGroup>
          )}
          <div className="flex flex-wrap gap-2 md:ml-auto">
            {!view && (
              <Button
                disabled={busy}
                onClick={() => {
                  void act(connect)
                }}
              >
                {busy
                  ? 'Checking…'
                  : needsReconnect
                    ? 'Reconnect Claude'
                    : active
                      ? 'Check connection'
                      : 'Connect my account'}
              </Button>
            )}
            {active && !view && (
              <Button
                disabled={busy}
                variant="ghost"
                onClick={() => {
                  void act(async () => {
                    useLocalAgent.setState({ preference: await api.disableRemoteClaude(userId) })
                    useStore.getState().allowanceChanged()
                    setStatus(await api.remoteClaude(userId))
                  })
                }}
              >
                Disable hosted execution
              </Button>
            )}
            {active && (
              <Button
                disabled={busy}
                variant="ghost"
                onClick={() => {
                  void act(async () => {
                    await api.stopRemoteClaude(userId)
                    setStatus(await api.remoteClaude(userId))
                  })
                }}
              >
                Stop tasks
              </Button>
            )}
          </div>
        </div>
        {view && (
          <div className="mt-4 max-w-xl space-y-5">
            <p role="status" aria-live="polite" className="text-sm text-ink-soft">
              {view.status}
            </p>
            <div className="space-y-2">
              <h4 className="text-sm font-semibold">1. Sign in to Claude</h4>
              {signInUrl && view.active ? (
                <Button asChild>
                  <a href={signInUrl} target="_blank" rel="noopener noreferrer">
                    Open Claude sign-in <span aria-hidden>↗</span>
                  </a>
                </Button>
              ) : view.active ? (
                <Button disabled>Preparing sign-in…</Button>
              ) : null}
              <p className="text-xs text-ink-soft">Opens in a new tab. Sign in, then return here.</p>
            </div>
            {codeRequested && view.active && (
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!input.trim() || !view.ready) return
                  const value = input.trim()
                  setInput('')
                  void login.current?.send(value)
                }}
                className="space-y-2"
              >
                <h4 className="text-sm font-semibold">2. Enter your sign-in code</h4>
                <label htmlFor="hosted-sign-in-code" className="block text-sm">
                  Code from Claude
                </label>
                <Input
                  id="hosted-sign-in-code"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={1024}
                  disabled={!view.ready}
                  value={input}
                  aria-describedby="hosted-code-help"
                  onChange={(event) => setInput(event.target.value)}
                />
                <p id="hosted-code-help" className="text-xs text-ink-soft">
                  Paste the code from the Claude sign-in page. Keep this page open while we verify it.
                </p>
                <Button disabled={!view.ready || !input.trim()} type="submit">
                  Complete sign-in
                </Button>
              </form>
            )}
            <details className="text-xs text-ink-soft">
              <summary className="cursor-pointer">Troubleshooting details</summary>
              <pre
                className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/5 p-3"
                aria-label="Native Claude login output"
              >
                {view.text}
              </pre>
              <form
                className="mt-2 space-y-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!view.ready) return
                  const value = input
                  setInput('')
                  void login.current?.send(value)
                }}
              >
                <label htmlFor="hosted-terminal-input" className="block">
                  Other response requested by Claude
                </label>
                <Input
                  id="hosted-terminal-input"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={1024}
                  disabled={!view.ready}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                />
                <p>Use this only for another terminal prompt. An empty response presses Enter.</p>
                <Button disabled={!view.ready} type="submit" variant="ghost">
                  Send response
                </Button>
              </form>
            </details>
            <Button
              type="button"
              variant="bare"
              disabled={busy}
              onClick={() => {
                void act(async () => {
                  await login.current?.cancel()
                  login.current = undefined
                  setView(null)
                  setInput('')
                })
              }}
            >
              Cancel
            </Button>
          </div>
        )}
        <p className="mt-3 text-xs text-ink-faint">
          Claude handles sign-in and stores its credentials in your hosted workspace. Disabling execution stops Doop
          tasks and signs you out of Claude. Connecting again requires sign-in.
        </p>
        {error && (
          <p role="alert" className="mt-3 text-sm text-accent-ink">
            {error}
          </p>
        )}
      </div>
    </section>
  )
}
