import { useEffect, useState } from 'react'
import { authClient } from '../lib/auth'
import { api } from '../lib/api'
import { isDesktopShell } from '../lib/shell'
import {
  disconnectLocalAgent,
  hasLocalClaude,
  invokeClaude,
  refreshLocalAgent,
  selectLocalAgent,
  useLocalAgent,
} from '../lib/localAgent'
import type { ClaudeModel } from '../../shared/localAgent'
import { Button } from './ui/button'
import { ToggleChipGroup, ToggleChipItem } from './ui/toggle-chip'

export function LocalClaudeRow() {
  const { data: session } = authClient.useSession()
  const userId = session?.user.id
  const { preference, native, running, progress, error: runnerError } = useLocalAgent()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (userId) refreshLocalAgent(userId).catch((e: unknown) => setError(String(e)))
  }, [userId])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const active = preference?.enabled ?? false
  const connected = !!native?.connected && !!native?.enabled
  const supported = hasLocalClaude()
  const choose = (model: ClaudeModel = preference?.model ?? 'default') =>
    act(async () => {
      if (!userId) return
      await selectLocalAgent(userId, { enabled: true, model })
    })

  return (
    <section
      className={`flex gap-[14px] border-b border-line-soft px-[22px] py-[18px] last:border-b-0 max-md:px-4 ${active ? 'bg-[linear-gradient(90deg,rgba(63,156,82,0.05),transparent_40%)]' : ''}`}
    >
      <span
        aria-hidden="true"
        className="grid h-9 w-9 flex-none place-items-center rounded-[11px] border border-line bg-paper-deep text-lg text-accent-ink"
      >
        ✳
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2.5">
          <h3 className="font-display text-[18px] font-extrabold tracking-[-0.02em] text-ink">Claude · Local CLI</h3>
          <span className="rounded-full bg-paper-deep px-2 py-1 text-xs font-bold text-ink-soft">
            {connected ? 'Connected' : native?.installed ? 'Not connected' : 'Requires desktop CLI'}
          </span>
          {active && <span className="text-xs font-bold text-[#1a6b43]">Active</span>}
        </div>
        <p className="mt-1.5 text-[14px] leading-relaxed text-ink-soft">
          Runs on this computer using your Claude Code login. Your provider’s usage limits apply.
        </p>
        {native?.email && (
          <p className="mt-3 text-sm text-ink-soft">
            Signed in as <span className="font-mono">{native.email}</span>
            {native.plan ? ` · ${native.plan}` : ''}
          </p>
        )}
        {!supported ? (
          <p className="mt-3 text-sm text-ink-faint">
            {isDesktopShell()
              ? 'Update the Doop desktop app to connect Claude.'
              : 'Open the Doop desktop app to connect Claude on this computer.'}
          </p>
        ) : (
          <>
            {!native?.installed && (
              <p className="mt-3 text-sm text-ink-soft">
                Install{' '}
                <a className="underline" href="https://code.claude.com/docs/en/setup" target="_blank" rel="noreferrer">
                  Claude Code
                </a>
                , then refresh.
              </p>
            )}
            {native?.installed && !native.connected && (
              <p className="mt-3 text-sm text-ink-soft">
                Sign in with Claude, or run <code>claude auth login</code> in your terminal and refresh.
              </p>
            )}
            <div className="mt-[18px] flex flex-wrap items-center justify-between gap-4">
              <ToggleChipGroup
                aria-label="Claude model"
                value={preference?.model ?? 'default'}
                disabled={busy || running || !native?.connected}
                onValueChange={(model) => choose(model as ClaudeModel)}
              >
                {(['default', 'sonnet', 'opus'] as const).map((model) => (
                  <ToggleChipItem key={model} value={model}>
                    {model === 'default' ? 'CLI default' : model === 'sonnet' ? 'Sonnet' : 'Opus'}
                  </ToggleChipItem>
                ))}
              </ToggleChipGroup>
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" disabled={busy} onClick={() => act(() => refreshLocalAgent(userId!))}>
                  Refresh
                </Button>
                {native?.installed && !native.connected && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        await invokeClaude('claude_login')
                        await refreshLocalAgent(userId!)
                      })
                    }
                  >
                    {busy ? 'Waiting for sign-in…' : 'Sign in'}
                  </Button>
                )}
                {native?.connected && !active && (
                  <Button disabled={busy} onClick={() => choose()}>
                    Use instead
                  </Button>
                )}
                {native?.connected && active && !connected && (
                  <Button disabled={busy} onClick={() => choose()}>
                    Connect this computer
                  </Button>
                )}
                {connected && (
                  <Button variant="danger" disabled={busy} onClick={() => act(() => disconnectLocalAgent(userId!))}>
                    Disconnect
                  </Button>
                )}
                {running && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        await invokeClaude('claude_stop')
                        await api.stopLocalAgent()
                      })
                    }
                  >
                    Stop task
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
        {active && (
          <p className="mt-3 text-sm text-ink-faint">
            {running
              ? 'Claude is working…'
              : connected
                ? 'Ready while this desktop app is open.'
                : 'Waiting for a connected desktop.'}{' '}
            Tasks stay on Claude until you select another provider. Repository imports and paid image generation require
            a server provider.
          </p>
        )}
        {progress && (
          <details className="mt-3 text-sm text-ink-soft">
            <summary>Latest Claude output</summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-sans" aria-live="polite">
              {progress}
            </pre>
          </details>
        )}
        {(error || runnerError) && (
          <p role="alert" className="mt-3 text-sm text-accent-ink">
            {error || runnerError}
          </p>
        )}
      </div>
    </section>
  )
}
