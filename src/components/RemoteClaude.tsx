import { useEffect, useRef, useState } from 'react'
import { authClient } from '../lib/auth'
import { api, ApiError } from '../lib/api'
import { useLocalAgent } from '../lib/localAgent'
import { useStore } from '../lib/store'
import { RemoteClaudeLogin, anthropicLinks, type LoginView } from '../lib/remoteClaudeLogin'
import { CLAUDE_MODELS, normalizeClaudeModel } from '../../shared/localAgent'
import type { RemoteClaudeStatus } from '../../shared/remoteClaude'
import { AgentIcon } from './AgentIcon'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { CheckIcon } from './ui/icons'
import { ToggleChip, ToggleChipGroup, ToggleChipItem } from './ui/toggle-chip'
import { planRow, planMark, planPill, actionsRow } from './ui/model-plan'
import { cn } from '@/lib/utils'

const planHead =
  'flex items-center gap-[10px] max-md:flex-wrap max-md:items-start max-md:gap-x-[9px] max-md:gap-y-[6px]'
const planTitle = 'font-display text-[18px] font-extrabold normal-case tracking-[-0.02em] text-ink max-md:text-[17px]'
const planBlurb = 'mt-1.5 text-[14px] leading-[1.55] text-ink-soft max-md:text-[13.5px]'

/**
 * The Claude Plan: the Doop Agent on the user's own Claude subscription. It
 * runs Claude Code in a private hosted workspace, so nothing on this machine
 * has to stay open — and the same row serves the browser and the desktop app.
 *
 * `replaces` says another model account is already connected, so the connect
 * action reads as a switch, the way it does on every other provider row.
 */
export function RemoteClaudeRow({ replaces = false }: { replaces?: boolean }) {
  const { data: session } = authClient.useSession()
  return session?.user.id ? (
    <RemoteClaudeConnection key={session.user.id} userId={session.user.id} replaces={replaces} />
  ) : null
}

/** A server without hosted execution has no Claude Plan to offer: the row
 *  stays, muted, so the list keeps its shape and says why. */
function UnavailableClaudePlanRow() {
  return (
    <section aria-label="Claude Plan" className={cn(planRow(false), 'bg-[#fafafa]')}>
      <span aria-hidden className={cn(planMark(false), 'border-[#e5e5e3] bg-[#f0f0ef] opacity-45 grayscale')}>
        <AgentIcon name="claude" size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <div className={planHead}>
          <h3 className={cn(planTitle, 'text-[#8a8a86]')}>Claude Plan</h3>
          <span className={cn(planPill(false), 'bg-[#ededeb] text-[#74746e]')}>Not available</span>
        </div>
        <p className={cn(planBlurb, 'text-[#92928d]')}>Use your Claude subscription.</p>
        <div className="mt-[18px] flex flex-wrap gap-[9px]">
          {CLAUDE_MODELS.map((model) => (
            <ToggleChip key={model.id} state="idle" className="bg-[#f0f0ee] text-[#9b9b96] opacity-100">
              {model.name}
            </ToggleChip>
          ))}
        </div>
        <p className="mt-[13px] text-[13px] text-[#7b7b75]">This server is not set up for hosted Claude execution.</p>
      </div>
    </section>
  )
}

function RemoteClaudeConnection({ userId, replaces }: { userId: string; replaces: boolean }) {
  const preference = useLocalAgent((state) => state.preference)
  const [status, setStatus] = useState<RemoteClaudeStatus | null>(null)
  const [view, setView] = useState<LoginView | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [logoutPending, setLogoutPending] = useState(false)
  const login = useRef<RemoteClaudeLogin>()
  const active = !!preference?.enabled && preference.transport === 'remote'
  const needsReconnect = active && !!status?.authRequired
  const model = normalizeClaudeModel(preference?.model)
  const selectedBlurb = CLAUDE_MODELS.find((option) => option.id === model)?.blurb
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
            : 'Could not update your Claude Plan.',
      )
    } finally {
      setBusy(false)
    }
  }
  async function select(selected = model, loginAttemptId?: string, loginCursor?: string) {
    const saved = await api.selectRemoteClaude(userId, selected, loginAttemptId, loginCursor)
    useLocalAgent.setState({ preference: saved })
    useStore.getState().allowanceChanged()
    setStatus(await api.remoteClaude(userId))
    setView(null)
    setLogoutPending(false)
  }
  async function disconnect() {
    try {
      const preference = await api.disableRemoteClaude(userId)
      useLocalAgent.setState({ preference })
      setLogoutPending(false)
    } catch (error) {
      // Execution may already be disabled even when native logout fails.
      setLogoutPending(true)
      try {
        useLocalAgent.setState({ preference: await api.localAgent() })
      } catch {
        // Preserve the original failure and keep logout retry available.
      }
      throw error
    } finally {
      useStore.getState().allowanceChanged()
    }
    setStatus(await api.remoteClaude(userId))
  }
  async function connect() {
    if (active && !status?.authRequired && (await api.checkRemoteClaude(userId)).authenticated) {
      await select()
      return
    }
    login.current?.dispose()
    const connection = new RemoteClaudeLogin(userId, setView, (attemptId, cursor) =>
      act(() => select(model, attemptId, cursor)),
    )
    login.current = connection
    await connection.start(status?.authRequired ?? false)
  }
  if (!status) return null
  if (!status.configured) return <UnavailableClaudePlanRow />
  return (
    <section className={planRow(active)} aria-label="Claude Plan">
      <span aria-hidden className={planMark(active)}>
        <AgentIcon name="claude" size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <div className={planHead}>
          <h3 className={planTitle}>Claude Plan</h3>
          <span className={planPill(active && !needsReconnect)}>
            {needsReconnect ? 'Sign-in required' : active ? 'Active · Connected' : 'Not connected'}
          </span>
        </div>
        <p className={planBlurb}>
          Use your Claude subscription. Tasks run in a private hosted workspace and carry on when you close Doop.
        </p>
        {needsReconnect && (
          <p className="mt-2 text-sm text-ink-soft">
            Connect Claude to resume hosted tasks. You can retry interrupted tasks after signing in.
          </p>
        )}
        <div className={actionsRow}>
          {active ? (
            <ToggleChipGroup
              aria-label="Claude model"
              value={model}
              disabled={busy || !!view}
              onValueChange={(next) => {
                void act(() => select(normalizeClaudeModel(next)))
              }}
            >
              {CLAUDE_MODELS.map((option) => (
                <ToggleChipItem key={option.id} value={option.id} title={option.blurb}>
                  {option.id === model && (
                    <CheckIcon width={13} height={13} strokeWidth={2.5} color="#1a6b43" aria-hidden />
                  )}
                  {option.name}
                </ToggleChipItem>
              ))}
            </ToggleChipGroup>
          ) : (
            /* inert on a row that is not the connected one — a capability list, not a control */
            <div className="flex flex-wrap gap-[9px]">
              {CLAUDE_MODELS.map((option) => (
                <ToggleChip key={option.id} state="idle">
                  {option.name}
                </ToggleChip>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2 max-md:[&>button]:flex-1">
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
                      : replaces
                        ? 'Use instead'
                        : 'Connect'}
              </Button>
            )}
            {active && (
              <Button
                disabled={busy}
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
            {(active || logoutPending) && !view && (
              <Button
                disabled={busy}
                variant="danger"
                onClick={() => {
                  void act(disconnect)
                }}
              >
                {logoutPending ? 'Retry sign-out' : 'Disconnect'}
              </Button>
            )}
          </div>
        </div>
        {active && !view && <p className="mt-[10px] text-[13px] text-ink-faint">{selectedBlurb}</p>}
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
          Claude handles sign-in and keeps its credentials in your hosted workspace. Disconnecting stops running tasks
          and signs you out of Claude; connecting again needs a fresh sign-in.
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
