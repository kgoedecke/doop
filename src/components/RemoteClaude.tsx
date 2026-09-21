import { useEffect, useRef, useState } from 'react'
import { authClient } from '../lib/auth'
import { api } from '../lib/api'
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
  const model = normalizeClaudeModel(preference?.model)
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
    window.addEventListener('focus', refresh)
    return () => {
      disposed = true
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
      setError(e instanceof Error ? e.message : 'Could not update hosted execution.')
    } finally {
      setBusy(false)
    }
  }
  async function select(selected = model) {
    const saved = await api.selectRemoteClaude(userId, selected)
    useLocalAgent.setState({ preference: saved })
    useStore.getState().allowanceChanged()
    setStatus(await api.remoteClaude(userId))
    setView(null)
  }
  async function connect() {
    if ((await api.checkRemoteClaude(userId)).authenticated) {
      await select()
      return
    }
    login.current?.dispose()
    const connection = new RemoteClaudeLogin(userId, setView, () => act(() => select()))
    login.current = connection
    await connection.start()
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
          <span className={planPill(active)}>{active ? 'Active' : 'Available'}</span>
        </div>
        <p className="mt-1.5 text-[14px] leading-[1.55] text-ink-soft">
          Run Claude Code with your own account in a private hosted workspace. Tasks continue when you close Doop.
        </p>
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
          <div className="flex flex-wrap gap-2">
            {!view && (
              <Button
                disabled={busy}
                onClick={() => {
                  void act(connect)
                }}
              >
                {busy ? 'Checking…' : active ? 'Check connection' : 'Connect my account'}
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
          <div className="mt-4 space-y-3">
            <p role="status" className="text-sm">
              {view.status}
            </p>
            {anthropicLinks(view.text).map((url) => (
              <a className="block text-sm underline" key={url} href={url} target="_blank" rel="noopener noreferrer">
                Open Anthropic sign-in
              </a>
            ))}
            <pre
              className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-black/5 p-3 text-xs"
              aria-label="Native Claude login output"
            >
              {view.text}
            </pre>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                const value = input
                setInput('')
                void login.current?.send(value)
              }}
              className="space-y-2"
            >
              <label htmlFor="hosted-terminal-input" className="block text-sm">
                Response requested by Claude’s terminal
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
              <p className="text-xs text-ink-soft">
                Enter a code only when the terminal asks. An empty response presses Enter. Keep this page open during
                sign-in.
              </p>
              <Button disabled={!view.ready} type="submit">
                Send response
              </Button>
              <Button
                type="button"
                variant="ghost"
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
                Cancel login
              </Button>
            </form>
          </div>
        )}
        <p className="mt-3 text-xs text-ink-faint">
          Claude handles sign-in and stores its credentials in your hosted workspace. Disabling execution stops Doop
          tasks; it does not sign you out of that workspace.
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
