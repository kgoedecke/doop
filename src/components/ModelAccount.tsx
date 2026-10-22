import { planRow, planMark, planPill, planAsCode, actionsRow } from './ui/model-plan'
import { BrandMark } from './ui/brand-mark'
import { AgentIcon } from './AgentIcon'
import { LocalClaudeRow } from './LocalClaude'
import { authClient } from '../lib/auth'
import { selectLocalAgent, useLocalAgent } from '../lib/localAgent'
import { isDesktopShell } from '../lib/shell'
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../lib/api'
import type { DeviceFlow, ModelAccountKind, ModelAccountStatus } from '../lib/api'
import { posthog } from '../lib/posthog'
import { useStore } from '../lib/store'
import { CodeBlock } from './ui/code-block'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dot } from './ui/dot'
import { cn } from '@/lib/utils'

/**
 * "Keep the Doop Agent running on my own subscription."
 *
 * OpenAI issues no redirect URI for a hosted app, so connecting ChatGPT takes
 * one of three shapes, cheapest first:
 *
 *  - Doop on this machine: it holds the loopback port and catches the redirect
 *    itself. Approve in the OpenAI tab, nothing to copy.
 *  - Doop hosted: device code — type a short code at auth.openai.com while the
 *    server polls. Needs "device code authorization" on in ChatGPT settings.
 *  - Fallback: paste the dead redirect page's address back here.
 *
 * The code exchange always happens on the server; no token touches this file.
 */

export function useModelAccount(): {
  account: ModelAccountStatus | null
  refresh: () => void
  set: (next: ModelAccountStatus) => void
} {
  const [account, setAccount] = useState<ModelAccountStatus | null>(null)
  const refresh = useCallback(() => {
    api.modelAccount().then(setAccount, () => {})
  }, [])
  useEffect(() => {
    refresh()
    const timer = window.setInterval(refresh, 5 * 60_000)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])
  return { account, refresh, set: setAccount }
}

/**
 * `chatgpt_plan_type` arrives as OpenAI's internal slug, and some of them do
 * not survive naive capitalisation — "prolite" is the Pro Lite tier, not
 * "Prolite". Known slugs get their real product name; anything new falls back
 * to title case so an unreleased tier still reads sensibly.
 */
const PLAN_NAMES: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  pro_lite: 'Pro Lite',
  team: 'Business',
  business: 'Business',
  team_business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
}

function planName(plan: string): string {
  const slug = plan.trim().toLowerCase()
  return (
    PLAN_NAMES[slug] ??
    slug
      .split(/[_\s-]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  )
}

const planFlow = 'mt-[14px]'
const maSteps = 'mb-3 ml-[18px] mt-[10px] text-body leading-[1.7] text-ink-soft [&_code]:font-mono [&_code]:text-label'
const maWaiting = 'mt-[10px] flex items-center gap-[9px] text-body text-ink-soft'
const maActions = 'mt-3 flex items-center gap-[10px] max-md:flex-col max-md:items-stretch'
/* the "or paste the redirect instead" style link under a flow */
const maToggle = 'mt-4 block px-0 py-0 text-left text-body font-normal text-ink-faint hover:bg-transparent'
/* the paste-your-redirect field: ink-bordered so it reads as the live step */
const maInput = 'rounded-pill border-ink px-3 py-[10px] font-mono focus:ring-0 md:text-xs'
/* buttons in the responsive action rows centre their label once stacked */
const rowBtn = 'max-md:justify-center'

export function ModelAccountPanel({ onChange }: { onChange?: () => void }) {
  const desktop = isDesktopShell()
  const { account, refresh, set } = useModelAccount()
  const { data: session } = authClient.useSession()
  const local = useLocalAgent((s) => s.preference)
  const userId = session?.user.id
  const localModel = local?.model ?? 'default'
  const selectServer = useCallback(async () => {
    if (userId) await selectLocalAgent(userId, { enabled: false, model: localModel })
  }, [userId, localModel])
  const [authUrl, setAuthUrl] = useState('')
  /* true while the server is listening on the loopback callback port for us —
     the user approves in the other tab and this one just flips */
  const [waiting, setWaiting] = useState(false)
  const [device, setDevice] = useState<DeviceFlow | null>(null)
  const [redirect, setRedirect] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState<false | Exclude<ModelAccountKind, 'chatgpt'>>(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [switchFailed, setSwitchFailed] = useState(false)

  const settle = useCallback(
    (next: ModelAccountStatus) => {
      set(next)
      setAuthUrl('')
      setWaiting(false)
      setDevice(null)
      setRedirect('')
      setApiKey('')
      setShowKey(false)
      setError('')
      setSwitchFailed(false)
      onChange?.()
      /* every allowance meter and wall on screen re-reads, not just this pane */
      useStore.getState().allowanceChanged()
    },
    [set, onChange],
  )

  const activateChatgpt = useCallback(
    async (next: ModelAccountStatus) => {
      // Authorization is complete even if selecting the provider subsequently fails.
      // Keep the connected account visible so retry never exchanges the OAuth code again.
      settle(next)
      setBusy(true)
      try {
        await selectServer()
      } catch {
        setSwitchFailed(true)
        setError('ChatGPT connected, but switching providers failed. Retry the switch without signing in again.')
      } finally {
        setBusy(false)
      }
    },
    [settle, selectServer],
  )

  /* poll only while a sign-in is actually in flight */
  const pendingDevice = device?.status === 'pending'
  useEffect(() => {
    if (!waiting && !pendingDevice) return
    let cancelled = false
    const id = window.setInterval(() => {
      api
        .modelAccount()
        .then(async (next) => {
          // An existing API-key account is not evidence that OAuth succeeded.
          if (cancelled || !next.connected || next.kind !== 'chatgpt') return
          cancelled = true
          await activateChatgpt(next)
        })
        .catch(() => {})
      /* the device flow can also fail server-side (expired, refused) — that
         status is the only place the user would ever learn why */
      if (pendingDevice) {
        api.deviceAuthStatus().then(
          (flow) => {
            if (!cancelled && 'userCode' in flow && flow.status === 'error') {
              setDevice(null)
              setError(flow.error || 'That sign-in did not complete')
            }
          },
          () => {},
        )
      }
    }, 1500)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [waiting, pendingDevice, activateChatgpt])

  const fail = (e: unknown) => {
    const body = (e as { body?: { error?: string } })?.body
    setError(body?.error || (e instanceof Error ? e.message : 'That did not work — try again'))
  }

  const start = async () => {
    setBusy(true)
    setError('')
    try {
      const { url, catching } = await api.chatgptAuthorize()
      if (catching) {
        /* we hold the loopback port, so the browser round trip completes by
           itself — the cheapest flow, and it needs no account setting */
        setAuthUrl(url)
        setWaiting(true)
        window.open(url, '_blank', 'noopener')
        posthog.capture('chatgpt_connect_started', { flow: 'loopback' })
        return
      }
      setDevice(await api.startDeviceAuth())
      posthog.capture('chatgpt_connect_started', { flow: 'device' })
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const cancelDevice = () => {
    setDevice(null)
    api.cancelDeviceAuth().catch(() => {})
  }

  /* the escape hatch when device codes are unavailable (workspace admin has
     not allowed them): fall back to the browser redirect and a paste */
  const usePasteFlow = async () => {
    setBusy(true)
    setError('')
    try {
      const { url } = await api.chatgptAuthorize()
      cancelDevice()
      setAuthUrl(url)
      setWaiting(false)
      window.open(url, '_blank', 'noopener')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const finish = async () => {
    setBusy(true)
    setError('')
    try {
      const next = await api.connectChatgpt(redirect)
      await activateChatgpt(next)
      posthog.capture('chatgpt_connected')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const saveKey = async () => {
    setBusy(true)
    setError('')
    try {
      const connect =
        showKey === 'anthropic-key'
          ? api.connectAnthropicKey
          : showKey === 'openrouter-key'
            ? api.connectOpenRouterKey
            : showKey === 'gemini-key'
              ? api.connectGeminiKey
              : api.connectOpenAiKey
      const next = await connect(apiKey)
      if (account?.kind !== showKey) await selectServer()
      settle(next)
      posthog.capture('model_account_connected', { kind: showKey || 'openai-key' })
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      settle(await api.disconnectModelAccount())
      posthog.capture('model_account_disconnected')
    } catch (e) {
      fail(e)
      refresh()
    } finally {
      setBusy(false)
    }
  }

  if (!account) return null

  const onChatgpt = account.connected && account.kind === 'chatgpt'
  /* only one account is stored per user, so connecting one replaces the other */
  const replaces = account.connected

  /* Provider rows manage connection, key rotation, and activation. */
  const keySection = (cfg: {
    kind: Exclude<ModelAccountKind, 'chatgpt'>
    title: string
    lede: string
    mark: ReactNode
    placeholder: string
  }) => {
    const live = account.connected && account.kind === cfg.kind
    return (
      <section className={planRow(live && !local?.enabled)} key={cfg.kind}>
        <span className={planMark(live && !local?.enabled)}>{cfg.mark}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-[10px] max-md:flex-wrap max-md:items-start max-md:gap-x-[9px] max-md:gap-y-[6px]">
            <h3 className="font-display text-heading font-extrabold normal-case tracking-[-0.02em] text-ink max-md:text-heading">
              {cfg.title}
            </h3>
            <span className={planPill(live)}>
              {live && showKey !== cfg.kind ? (local?.enabled ? 'Connected' : 'Active · Connected') : 'Not connected'}
            </span>
          </div>
          <p className="mt-1.5 text-copy leading-[1.55] text-ink-soft max-md:text-copy">{cfg.lede}</p>

          {live && showKey !== cfg.kind ? (
            <>
              <div className={actionsRow}>
                <div className="flex flex-wrap gap-2 max-md:[&>button]:flex-1">
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setApiKey('')
                      setShowKey(cfg.kind)
                    }}
                  >
                    Rotate key
                  </Button>
                  {local?.enabled && (
                    <Button
                      disabled={busy}
                      onClick={() => {
                        selectServer().catch(fail)
                      }}
                    >
                      Use instead
                    </Button>
                  )}
                  <Button variant="danger" className={rowBtn} onClick={remove} disabled={busy}>
                    Disconnect
                  </Button>
                </div>
              </div>
            </>
          ) : showKey === cfg.kind ? (
            <div className={planFlow}>
              <p className="mb-3 mt-2 text-body leading-[1.55] text-ink-soft">
                The key is stored on the server and never shown again.
              </p>
              <Input
                className={maInput}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={cfg.placeholder}
                type="password"
                autoFocus
                spellCheck={false}
              />
              <div className={maActions}>
                <Button variant="primary" className={rowBtn} onClick={saveKey} disabled={busy || !apiKey.trim()}>
                  {busy ? 'Saving…' : live ? 'Rotate key' : 'Save key'}
                </Button>
                <Button variant="ghost" className={rowBtn} onClick={() => setShowKey(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className={actionsRow}>
              <Button
                className={rowBtn}
                onClick={() => {
                  setApiKey('')
                  setShowKey(cfg.kind)
                }}
                disabled={busy}
              >
                {replaces ? 'Use instead' : 'Connect'}
              </Button>
            </div>
          )}
        </div>
      </section>
    )
  }

  return (
    <div className="flex flex-col">
      {account.chatgptEnabled !== false && (
        <section className={planRow(onChatgpt && !local?.enabled)}>
          <span className={planMark(onChatgpt && !local?.enabled)}>
            <OpenAiMark />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-[10px] max-md:flex-wrap max-md:items-start max-md:gap-x-[9px] max-md:gap-y-[6px]">
              <h3 className="font-display text-heading font-extrabold normal-case tracking-[-0.02em] text-ink max-md:text-heading">
                Codex Plan
              </h3>
              <span className={planPill(onChatgpt)}>
                {onChatgpt ? (local?.enabled ? 'Connected' : 'Active · Connected') : 'Not connected'}
              </span>
            </div>
            <p className="mt-1.5 text-copy leading-[1.55] text-ink-soft max-md:text-copy">
              Route OpenAI models through your ChatGPT subscription
            </p>
            {onChatgpt && account.email && (
              <dl className="mt-[14px] grid grid-cols-[auto_auto] items-center justify-start gap-x-[14px] gap-y-2 text-body text-ink-soft max-md:grid-cols-1 max-md:gap-[3px]">
                <dt>Connected as</dt>
                <dd className="min-w-0">
                  <code className={planAsCode}>{account.email}</code>
                </dd>
                {account.plan && (
                  <>
                    <dt className="max-md:mt-2">Plan</dt>
                    <dd className="min-w-0">
                      <code className={planAsCode}>{planName(account.plan)}</code>
                    </dd>
                  </>
                )}
              </dl>
            )}

            {onChatgpt ? (
              <>
                <div className={actionsRow}>
                  <div className="flex flex-wrap gap-2 max-md:[&>button]:flex-1">
                    {(local?.enabled || switchFailed) && (
                      <Button disabled={busy} onClick={() => activateChatgpt(account)}>
                        {switchFailed ? 'Retry switch' : 'Use instead'}
                      </Button>
                    )}
                    <Button variant="danger" className={rowBtn} onClick={remove} disabled={busy}>
                      Disconnect
                    </Button>
                  </div>
                </div>
              </>
            ) : device ? (
              <div className={planFlow}>
                <ol className={maSteps}>
                  <li>
                    One-time setup: turn on <b>device code authorization</b> in ChatGPT → Settings → Security. (On a
                    workspace account an admin has to allow it.)
                  </li>
                  <li>
                    Open{' '}
                    <a href={device.verificationUrl} target="_blank" rel="noreferrer noopener">
                      {device.verificationUrl.replace(/^https:\/\//, '')}
                    </a>{' '}
                    and enter this code:
                  </li>
                </ol>
                <CodeBlock text={device.userCode} />
                <p className={maWaiting}>
                  <Dot className="animate-[arrival-pulse_1.6s_ease-in-out_infinite] bg-brand" /> Waiting for approval…
                </p>
                <div className={maActions}>
                  <Button asChild variant="primary" className={rowBtn}>
                    <a href={device.verificationUrl} target="_blank" rel="noreferrer noopener">
                      Open verification page
                    </a>
                  </Button>
                  <Button variant="ghost" className={rowBtn} onClick={cancelDevice}>
                    Cancel
                  </Button>
                </div>
                <Button variant="bare" size="sm" className={maToggle} onClick={usePasteFlow} disabled={busy}>
                  Device codes not available on your account? Use the browser sign-in instead
                </Button>
              </div>
            ) : waiting ? (
              <div className={planFlow}>
                {/* Doop holds the loopback port itself, so approving is the
                    whole job — this row flips on its own. */}
                <p className={maWaiting}>
                  <Dot className="animate-[arrival-pulse_1.6s_ease-in-out_infinite] bg-brand" /> Waiting for you to
                  approve it in the other tab…
                </p>
                <div className={maActions}>
                  <Button asChild variant="ghost" className={rowBtn}>
                    <a href={authUrl} target="_blank" rel="noreferrer noopener">
                      Reopen sign-in
                    </a>
                  </Button>
                  <Button
                    variant="bare"
                    size="sm"
                    className={cn(maToggle, 'mt-0 underline')}
                    onClick={() => setWaiting(false)}
                  >
                    Paste the redirect URL instead
                  </Button>
                </div>
              </div>
            ) : authUrl ? (
              <div className={planFlow}>
                <ol className={maSteps}>
                  <li>Approve the connection in the tab that just opened.</li>
                  <li>
                    You will land on a <code>localhost:1455</code> page that <b>fails to load</b> — that is expected.
                  </li>
                  <li>Copy that page's full address and paste it below.</li>
                </ol>
                <Input
                  className={maInput}
                  value={redirect}
                  onChange={(e) => setRedirect(e.target.value)}
                  placeholder="http://localhost:1455/auth/callback?code=…"
                  autoFocus
                  spellCheck={false}
                />
                <div className={maActions}>
                  <Button variant="primary" className={rowBtn} onClick={finish} disabled={busy || !redirect.trim()}>
                    {busy ? 'Connecting…' : 'Finish connecting'}
                  </Button>
                  <Button asChild variant="ghost" className={rowBtn}>
                    <a href={authUrl} target="_blank" rel="noreferrer noopener">
                      Reopen sign-in
                    </a>
                  </Button>
                </div>
              </div>
            ) : (
              <div className={actionsRow}>
                <Button className={rowBtn} onClick={start} disabled={busy}>
                  {busy ? 'Opening…' : replaces ? 'Use instead' : 'Connect'}
                </Button>
              </div>
            )}
          </div>
        </section>
      )}

      {keySection({
        kind: 'openai-key',
        title: 'OpenAI API key',
        lede: 'Pay per token on your own OpenAI account — no ChatGPT subscription involved',
        mark: <OpenAiMark />,
        placeholder: 'sk-…',
      })}

      {keySection({
        kind: 'openrouter-key',
        title: 'OpenRouter API key',
        lede: 'One key for Kimi, Qwen, GLM, DeepSeek, MiniMax, Gemini and more — pay per token on your OpenRouter account',
        mark: <OpenRouterMark />,
        placeholder: 'sk-or-…',
      })}

      {keySection({
        kind: 'gemini-key',
        title: 'Gemini API key',
        lede: 'Google’s Gemini models, plus Nano Banana image generation — pay per token on your Google AI account',
        mark: <GeminiMark />,
        placeholder: 'AIza…',
      })}

      {desktop && <LocalClaudeRow />}
      {keySection({
        kind: 'anthropic-key',
        title: 'Claude API key',
        lede: 'Pay per token on your Anthropic account. Runs on Doop’s server.',
        mark: <AgentIcon name="claude" size={20} />,
        placeholder: 'sk-ant-…',
      })}

      {/* the browser cannot run the local CLI, so the plan closes the list as a pointer to the desktop app */}
      {!desktop && <LocalClaudeRow />}
      {account.modelCatalogWarning && (
        <p role="status" className="mt-[10px] text-body text-accent-ink">
          {account.modelCatalogWarning}
        </p>
      )}
      {error && <p className="mt-[10px] text-body text-accent-ink">{error}</p>}
    </div>
  )
}

/** A forked-route glyph for OpenRouter, inlined like the other marks. */
function OpenRouterMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="2.1"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 12h3.5c3 0 4.5-4.5 7.5-4.5h3" />
      <path d="M2 12h3.5c3 0 4.5 4.5 7.5 4.5h3" />
      <path d="M15 4.5l4 3-4 3" />
      <path d="M15 13.5l4 3-4 3" />
    </svg>
  )
}

/* 18 in a 36px tile — the same mark-to-tile ratio the presence avatars use on
   a canvas, so the brand tile reads identically wherever it appears */
function GeminiMark() {
  return <BrandMark brand="gemini" size={18} />
}

function OpenAiMark() {
  return <BrandMark brand="openai" size={18} />
}
