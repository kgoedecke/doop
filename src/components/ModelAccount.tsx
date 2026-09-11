import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { DeviceFlow, ModelAccountStatus } from '../lib/api'
import { posthog } from '../lib/posthog'
import { useStore } from '../lib/store'
import { CodeBlock } from './ui/code-block'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dot } from './ui/dot'
import { ToggleChip, ToggleChipGroup, ToggleChipItem } from './ui/toggle-chip'
import { cn } from '@/lib/utils'
import { CheckIcon } from './ui/icons'

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
  useEffect(refresh, [refresh])
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

/* provider rows: one per model plan, divided rather than boxed — the set-card
   is the container. The connected one carries a green left-edge tint. */
const planRow = (live: boolean) =>
  cn(
    'flex gap-[14px] border-b border-line-soft px-[22px] py-[18px] last:border-b-0 max-md:gap-3 max-md:px-4 max-md:py-[17px]',
    live && 'bg-[linear-gradient(90deg,rgba(63,156,82,0.05),transparent_40%)]',
  )
const planMark = (live: boolean) =>
  cn(
    'grid h-9 w-9 flex-none place-items-center rounded-[11px] border border-line bg-paper-deep text-ink',
    live && 'border-black bg-black text-white',
  )
const planPill = (on: boolean) =>
  cn(
    'rounded-full bg-paper-deep px-[9px] py-[3px] text-[11.5px] font-bold text-ink-faint',
    on && 'bg-[rgba(30,122,76,0.12)] text-[#1a6b43]',
  )
/* the model tiers as chips — the base .chip recipe reshaped into the picker */
const planAsCode =
  'inline-block rounded-[7px] bg-paper-deep px-[9px] py-[3px] font-mono text-[12.5px] leading-[1.5] text-ink [overflow-wrap:anywhere]'
/* chips left, the row's action right, sharing one line */
const actionsRow =
  'mt-[18px] flex flex-wrap items-center justify-between gap-5 max-md:flex-col max-md:items-stretch max-md:gap-[10px]'
const planFlow = 'mt-[14px]'
const maSteps =
  'mb-3 ml-[18px] mt-[10px] text-[13px] leading-[1.7] text-ink-soft [&_code]:font-mono [&_code]:text-[12px]'
const maWaiting = 'mt-[10px] flex items-center gap-[9px] text-[13px] text-ink-soft'
const maActions = 'mt-3 flex items-center gap-[10px] max-md:flex-col max-md:items-stretch'
/* the "or paste the redirect instead" style link under a flow */
const maToggle = 'mt-4 block px-0 py-0 text-left text-[12.5px] font-normal text-ink-faint hover:bg-transparent'
/* the paste-your-redirect field: ink-bordered so it reads as the live step */
const maInput = 'rounded-[10px] border-ink px-3 py-[10px] font-mono focus:ring-0 md:text-xs'
/* buttons in the responsive action rows centre their label once stacked */
const rowBtn = 'max-md:justify-center'

export function ModelAccountPanel({ onChange }: { onChange?: () => void }) {
  const { account, refresh, set } = useModelAccount()
  const [authUrl, setAuthUrl] = useState('')
  /* true while the server is listening on the loopback callback port for us —
     the user approves in the other tab and this one just flips */
  const [waiting, setWaiting] = useState(false)
  const [device, setDevice] = useState<DeviceFlow | null>(null)
  const [redirect, setRedirect] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const settle = useCallback(
    (next: ModelAccountStatus) => {
      set(next)
      setAuthUrl('')
      setWaiting(false)
      setDevice(null)
      setRedirect('')
      setApiKey('')
      setError('')
      onChange?.()
      /* every allowance meter and wall on screen re-reads, not just this pane */
      useStore.getState().allowanceChanged()
    },
    [set, onChange],
  )

  /* poll only while a sign-in is actually in flight */
  const pendingDevice = device?.status === 'pending'
  useEffect(() => {
    if (!waiting && !pendingDevice) return
    const id = window.setInterval(() => {
      api.modelAccount().then(
        (next) => {
          if (next.connected) settle(next)
        },
        () => {},
      )
      /* the device flow can also fail server-side (expired, refused) — that
         status is the only place the user would ever learn why */
      if (pendingDevice) {
        api.deviceAuthStatus().then(
          (flow) => {
            if ('userCode' in flow && flow.status === 'error') {
              setDevice(null)
              setError(flow.error || 'That sign-in did not complete')
            }
          },
          () => {},
        )
      }
    }, 1500)
    return () => window.clearInterval(id)
  }, [waiting, pendingDevice, settle])

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
      settle(await api.connectChatgpt(redirect))
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
      settle(await api.connectOpenAiKey(apiKey))
      posthog.capture('model_account_connected', { kind: 'openai-key' })
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const pickModel = async (model: string) => {
    setBusy(true)
    setError('')
    try {
      set(await api.setAgentModel(model))
      posthog.capture('agent_model_changed', { model })
    } catch (e) {
      fail(e)
      refresh()
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

  const options = account.models ?? []
  const chosen = options.find((m) => m.id === account.model)
  const onChatgpt = account.connected && account.kind === 'chatgpt'
  const onKey = account.connected && account.kind === 'openai-key'
  /* only one account is stored per user, so connecting one replaces the other */
  const replaces = account.connected

  /* On the connected row the chips ARE the model picker; on any other row they
     only advertise what that plan can run, so they stay inert. */
  const modelChips = (live: boolean) =>
    live ? (
      <ToggleChipGroup aria-label="Model" value={account.model ?? ''} onValueChange={pickModel} disabled={busy}>
        {options.map((m) => (
          <ToggleChipItem key={m.id} value={m.id} title={m.blurb}>
            {m.id === account.model && <Tick />}
            {m.name}
          </ToggleChipItem>
        ))}
        {/* a server override outside the known tiers still has to be visible */}
        {account.model && !chosen && <ToggleChip state="on">{account.model}</ToggleChip>}
      </ToggleChipGroup>
    ) : (
      /* inert on a row that is not the connected one — a capability list, not a control */
      <div className="flex flex-wrap gap-[9px]">
        {options.map((m) => (
          <ToggleChip key={m.id} state="idle">
            {m.name}
          </ToggleChip>
        ))}
      </div>
    )

  return (
    <div className="flex flex-col">
      {account.chatgptEnabled !== false && (
        <section className={planRow(onChatgpt)}>
          <span className={planMark(onChatgpt)}>
            <OpenAiMark />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-[10px] max-md:flex-wrap max-md:items-start max-md:gap-x-[9px] max-md:gap-y-[6px]">
              <h3 className="font-display text-[18px] font-extrabold normal-case tracking-[-0.02em] text-ink max-md:text-[17px]">
                Codex Plan
              </h3>
              <span className={planPill(onChatgpt)}>{onChatgpt ? 'Connected' : 'Not connected'}</span>
            </div>
            <p className="mt-1.5 text-[14px] leading-[1.55] text-ink-soft max-md:text-[13.5px]">
              Route OpenAI models through your ChatGPT subscription
            </p>
            {onChatgpt && account.email && (
              <dl className="mt-[14px] grid grid-cols-[auto_auto] items-center justify-start gap-x-[14px] gap-y-2 text-[13px] text-ink-soft max-md:grid-cols-1 max-md:gap-[3px]">
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
                  {modelChips(true)}
                  <Button variant="danger" className={rowBtn} onClick={remove} disabled={busy}>
                    Disconnect
                  </Button>
                </div>
                {chosen && <p className="mt-[10px] text-[13px] text-ink-faint">{chosen.blurb}</p>}
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
                {modelChips(false)}
                <Button className={rowBtn} onClick={start} disabled={busy}>
                  {busy ? 'Opening…' : replaces ? 'Use instead' : 'Connect'}
                </Button>
              </div>
            )}
          </div>
        </section>
      )}

      <section className={planRow(onKey)}>
        <span className={planMark(onKey)}>
          <OpenAiMark />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-[10px] max-md:flex-wrap max-md:items-start max-md:gap-x-[9px] max-md:gap-y-[6px]">
            <h3 className="font-display text-[18px] font-extrabold normal-case tracking-[-0.02em] text-ink max-md:text-[17px]">
              OpenAI API key
            </h3>
            <span className={planPill(onKey)}>{onKey ? 'Connected' : 'Not connected'}</span>
          </div>
          <p className="mt-1.5 text-[14px] leading-[1.55] text-ink-soft max-md:text-[13.5px]">
            Pay per token on your own OpenAI account — no ChatGPT subscription involved
          </p>

          {onKey ? (
            <>
              <div className={actionsRow}>
                {modelChips(true)}
                <Button variant="danger" className={rowBtn} onClick={remove} disabled={busy}>
                  Disconnect
                </Button>
              </div>
              {chosen && <p className="mt-[10px] text-[13px] text-ink-faint">{chosen.blurb}</p>}
            </>
          ) : showKey ? (
            <div className={planFlow}>
              <p className="mb-3 mt-2 text-[13px] leading-[1.55] text-ink-soft">
                The key is stored on the server and never shown again.
              </p>
              <Input
                className={maInput}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-…"
                type="password"
                autoFocus
                spellCheck={false}
              />
              <div className={maActions}>
                <Button variant="primary" className={rowBtn} onClick={saveKey} disabled={busy || !apiKey.trim()}>
                  {busy ? 'Saving…' : 'Save key'}
                </Button>
                <Button variant="ghost" className={rowBtn} onClick={() => setShowKey(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className={actionsRow}>
              {modelChips(false)}
              <Button className={rowBtn} onClick={() => setShowKey(true)} disabled={busy}>
                {replaces ? 'Use instead' : 'Connect'}
              </Button>
            </div>
          )}
        </div>
      </section>

      {error && <p className="mt-[10px] text-[12.5px] text-accent-ink">{error}</p>}
    </div>
  )
}

function Tick() {
  return <CheckIcon width={13} height={13} strokeWidth={2.5} color="#1a6b43" aria-hidden />
}

/** OpenAI's mark, inlined so the page needs no external request. */
/* 18 in a 36px tile — the same mark-to-tile ratio the presence avatars use on
   a canvas, so the brand tile reads identically wherever it appears */
function OpenAiMark() {
  return (
    <svg viewBox="0 0 256 260" width="18" height="18" aria-hidden>
      <path
        fill="currentColor"
        d="M239.184 106.203a64.72 64.72 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.72 64.72 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.67 64.67 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.77 64.77 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483m-97.56 136.338a48.4 48.4 0 0 1-31.105-11.255l1.535-.87l51.67-29.825a8.6 8.6 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601M37.158 197.93a48.35 48.35 0 0 1-5.781-32.589l1.534.921l51.722 29.826a8.34 8.34 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803M23.549 85.38a48.5 48.5 0 0 1 25.58-21.333v61.39a8.29 8.29 0 0 0 4.195 7.316l62.874 36.272l-21.845 12.636a.82.82 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405zm179.466 41.695l-63.08-36.63L161.73 77.86a.82.82 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.54 8.54 0 0 0-4.4-7.213m21.742-32.69l-1.535-.922l-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.72.72 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391zM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87l-51.67 29.825a8.6 8.6 0 0 0-4.246 7.367zm11.868-25.58L128.067 97.3l28.188 16.218v32.434l-28.086 16.218l-28.188-16.218z"
      />
    </svg>
  )
}
