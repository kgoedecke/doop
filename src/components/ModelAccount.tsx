import { AppIcon } from './ui/brand-mark'
import { LocalClaudeRow } from './LocalClaude'
import { isDesktopShell } from '../lib/shell'
import { Fragment, useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../lib/api'
import type { AgentModelCatalog, AgentModelOption, DeviceFlow, ModelAccountKind, ModelAccounts } from '../lib/api'
import type { RunnerProvider } from '../../shared/agentRunner'
import { AvailableRow, ConnectionRow, FieldError, ConnectionSection, ModelSelect } from './ConnectionTable'
import { useLocalAgent } from '../lib/localAgent'
import { posthog } from '../lib/posthog'
import { useStore } from '../lib/store'
import { CodeBlock } from './ui/code-block'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'
import { Dot } from './ui/dot'
import { isReasoningEffort, reasoningEffortOptions, type ReasoningEffort } from '../../shared/modelMenu'
import { t as translate, useT, type PlainMessageKey } from '../lib/i18n'
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

export function useModelAccounts(): {
  view: ModelAccounts | null
  refresh: () => void
  set: (next: ModelAccounts) => void
} {
  const [view, setView] = useState<ModelAccounts | null>(null)
  const refresh = useCallback(() => {
    api.modelAccounts().then(setView, () => {})
  }, [])
  useEffect(refresh, [refresh])
  return { view, refresh, set: setView }
}

/**
 * One account's live model list, asked for while `wanted` is true (the
 * composer's picker is open) and again whenever the kind changes. Null until
 * it arrives and whenever it belongs to another account, so callers fall back
 * to the curated menu.
 */
export function useAgentModels(kind: ModelAccountKind | undefined, wanted: boolean): AgentModelCatalog | null {
  const [loaded, setLoaded] = useState<{ kind: ModelAccountKind; catalog: AgentModelCatalog }>()
  useEffect(() => {
    if (!kind || !wanted) return
    let stale = false
    api.agentModels(kind).then(
      (catalog) => {
        if (!stale) setLoaded({ kind, catalog })
      },
      () => {},
    )
    return () => {
      stale = true
    }
  }, [kind, wanted])
  return loaded && loaded.kind === kind ? loaded.catalog : null
}

/**
 * Every connected account's live model list, for the Settings pane, asked for
 * again whenever the set of accounts changes or `generation` is bumped: the
 * pane bumps it on every connect, rotation and disconnect, since a rotated
 * key keeps the account's kind and would otherwise keep showing the old key's
 * models. A kind missing from the result shows its curated menu.
 */
export function useAgentCatalogs(
  kinds: readonly ModelAccountKind[],
  generation: number,
): Partial<Record<ModelAccountKind, AgentModelCatalog>> {
  const key = kinds.join(',')
  const [loaded, setLoaded] = useState<{
    key: string
    generation: number
    catalogs: Partial<Record<ModelAccountKind, AgentModelCatalog>>
  }>()
  useEffect(() => {
    if (!key) return
    let stale = false
    const wanted = key.split(',') as ModelAccountKind[]
    void Promise.all(
      wanted.map((kind) =>
        api.agentModels(kind).then(
          (catalog) => [kind, catalog] as const,
          () => undefined,
        ),
      ),
    ).then((entries) => {
      if (stale) return
      const catalogs: Partial<Record<ModelAccountKind, AgentModelCatalog>> = {}
      for (const entry of entries) if (entry) catalogs[entry[0]] = entry[1]
      setLoaded({ key, generation, catalogs })
    })
    return () => {
      stale = true
    }
  }, [key, generation])
  return loaded && loaded.key === key && loaded.generation === generation ? loaded.catalogs : {}
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

/** The effort picker's labels; the ids are what the server stores. */
const EFFORT_LABELS: Record<ReasoningEffort, { name: PlainMessageKey; blurb: PlainMessageKey }> = {
  low: { name: 'models.effortLow', blurb: 'models.effortLowBlurb' },
  medium: { name: 'models.effortMedium', blurb: 'models.effortMediumBlurb' },
  high: { name: 'models.effortHigh', blurb: 'models.effortHighBlurb' },
  xhigh: { name: 'models.effortXhigh', blurb: 'models.effortXhighBlurb' },
}

const maSteps = 'mb-3 ml-[18px] mt-[10px] text-body leading-[1.7] text-ink-soft [&_code]:font-mono [&_code]:text-label'
const maWaiting = 'mt-[10px] flex items-center gap-[9px] text-body text-ink-soft'
const maActions = 'mt-3 flex items-center gap-[10px] max-md:flex-col max-md:items-stretch'
/* the "or paste the redirect instead" style link under a flow */
const maToggle = 'mt-4 block px-0 py-0 text-left text-body font-normal text-ink-faint hover:bg-transparent'
/* the paste-your-redirect field: ink-bordered so it reads as the live step */
const maInput =
  'rounded-pill border-ink px-3 py-[10px] font-mono focus:ring-0 aria-invalid:border-accent-ink md:text-xs'
/* buttons in the responsive action rows centre their label once stacked */
const rowBtn = 'max-md:justify-center'

/** One provider: a row of the table once connected, a card to connect before. */
interface Entry {
  connected: boolean
  node: ReactNode
}

export function ModelAccountPanel({ onChange }: { onChange?: () => void }) {
  const t = useT()
  const desktop = isDesktopShell()
  const { view, refresh, set } = useModelAccounts()
  const localState = useLocalAgent()
  const [showKey, setShowKey] = useState<false | Exclude<ModelAccountKind, 'chatgpt'>>(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /* the connection a failure belongs to, so it shows under that row or
     field; unset, it shows under the lists */
  const [errorAt, setErrorAt] = useState<ModelAccountKind | null>(null)
  /* bumped by `settle`, so a rotated key reloads the catalog it unlocks */
  const [catalogGeneration, setCatalogGeneration] = useState(0)
  const catalogs = useAgentCatalogs(view?.accounts.map((a) => a.kind) ?? [], catalogGeneration)
  const [authUrl, setAuthUrl] = useState('')
  /* true while the server is listening on the loopback callback port for us —
     the user approves in the other tab and this one just flips */
  const [waiting, setWaiting] = useState(false)
  const [device, setDevice] = useState<DeviceFlow | null>(null)
  const [redirect, setRedirect] = useState('')
  const [apiKey, setApiKey] = useState('')

  const settle = useCallback(
    (next: ModelAccounts) => {
      set(next)
      setCatalogGeneration((generation) => generation + 1)
      setAuthUrl('')
      setWaiting(false)
      setDevice(null)
      setRedirect('')
      setApiKey('')
      setShowKey(false)
      setError('')
      onChange?.()
      /* every allowance meter, wall and composer picker on screen re-reads */
      useStore.getState().allowanceChanged()
    },
    [set, onChange],
  )

  /* poll only while a sign-in is actually in flight */
  const pendingDevice = device?.status === 'pending'
  useEffect(() => {
    if (!waiting && !pendingDevice) return
    let cancelled = false
    const id = window.setInterval(() => {
      api
        .modelAccounts()
        .then((next) => {
          if (cancelled || !next.accounts.some((a) => a.kind === 'chatgpt')) return
          cancelled = true
          settle(next)
        })
        .catch(() => {})
      /* the device flow can also fail server-side (expired, refused) — that
         status is the only place the user would ever learn why */
      if (pendingDevice) {
        api.deviceAuthStatus().then(
          (flow) => {
            if (!cancelled && 'userCode' in flow && flow.status === 'error') {
              setDevice(null)
              setError(flow.error || translate('models.signInIncomplete'))
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
  }, [waiting, pendingDevice, settle])

  const fail = (e: unknown, at: ModelAccountKind | null = null) => {
    const body = (e as { body?: { error?: string } })?.body
    setError(body?.error || (e instanceof Error ? e.message : t('models.failedRetry')))
    setErrorAt(at)
  }

  /* one request that answers with the whole view; a failure re-reads it and
     shows under the connection it was about */
  const act = async (at: ModelAccountKind | null, request: () => Promise<ModelAccounts>, done?: () => void) => {
    setBusy(true)
    setError('')
    try {
      settle(await request())
      done?.()
    } catch (e) {
      fail(e, at)
      refresh()
    } finally {
      setBusy(false)
    }
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
      fail(e, 'chatgpt')
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
      fail(e, 'chatgpt')
    } finally {
      setBusy(false)
    }
  }

  const finish = () =>
    act(
      'chatgpt',
      () => api.connectChatgpt(redirect),
      () => posthog.capture('chatgpt_connected'),
    )

  const saveKey = () => {
    const kind = showKey || 'openai-key'
    const connect =
      kind === 'anthropic-key'
        ? api.connectAnthropicKey
        : kind === 'openrouter-key'
          ? api.connectOpenRouterKey
          : kind === 'gemini-key'
            ? api.connectGeminiKey
            : api.connectOpenAiKey
    return act(
      kind,
      () => connect(apiKey),
      () => posthog.capture('model_account_connected', { kind }),
    )
  }

  const pickModel = (kind: ModelAccountKind, model: string) =>
    act(
      kind,
      () => api.setAgentModel(kind, model),
      () => posthog.capture('agent_model_changed', { kind, model }),
    )
  const pickEffort = (kind: ModelAccountKind, effort: string) =>
    act(
      kind,
      () => api.setAgentEffort(kind, effort),
      () => posthog.capture('agent_effort_changed', { kind, effort }),
    )
  const toggle = (kind: ModelAccountKind, enabled: boolean) =>
    act(
      kind,
      () => api.setModelAccountEnabled(kind, enabled),
      () => posthog.capture('model_account_toggled', { kind, enabled }),
    )
  const remove = (kind: ModelAccountKind) =>
    act(
      kind,
      () => api.disconnectModelAccount(kind),
      () => posthog.capture('model_account_disconnected', { kind }),
    )
  const makeDefault = (provider: RunnerProvider) =>
    act(
      provider === 'claude-local' ? null : provider,
      () => api.setDefaultRunner(provider),
      () => posthog.capture('agent_default_changed', { provider }),
    )

  if (!view) return null

  /* the failure that belongs to this connection, if any */
  const errorFor = (kind: ModelAccountKind) => (error && errorAt === kind ? error : undefined)
  const typeKey = (value: string) => {
    setApiKey(value)
    /* a fresh attempt: the old complaint no longer describes the field */
    setError('')
  }

  const accountOf = (kind: ModelAccountKind) => view.accounts.find((a) => a.kind === kind)
  /* a connected row offers the provider's live list once it has arrived;
     every other row advertises its curated menu */
  const menuFor = (kind: ModelAccountKind): AgentModelOption[] => {
    const catalog = catalogs[kind]
    return (accountOf(kind) && catalog?.live ? catalog.models : undefined) ?? view.menus[kind] ?? []
  }

  /* the dropdown of a connected account: its models and, on the OpenAI
     kinds, the reasoning effort */
  const modelCell = (kind: ModelAccountKind, title: string) => {
    const account = accountOf(kind)
    const models = menuFor(kind)
    if (!account) return null
    return (
      <ModelSelect
        name={title}
        models={models}
        model={account.model}
        onModel={(model) => void pickModel(kind, model)}
        {...(account.effort
          ? {
              effort: account.effort,
              onEffort: (effort: string) => pickEffort(kind, effort),
              efforts: reasoningEffortOptions(account.effort).map((e) => {
                /* a server default outside the four keeps its raw id as its name */
                const labels = isReasoningEffort(e.id) ? EFFORT_LABELS[e.id] : undefined
                return {
                  id: e.id,
                  name: labels ? t(labels.name) : e.name,
                  blurb: labels ? t(labels.blurb) : t('models.effortServerDefault'),
                }
              }),
            }
          : {})}
        disabled={busy}
      />
    )
  }

  /* the line under a name: the text-only warning when the chosen model has
     no eyes, else what the provider is */
  const subFor = (kind: ModelAccountKind, lede: string) => {
    const account = accountOf(kind)
    const chosen = menuFor(kind).find((m) => m.id === account?.model)
    return chosen?.vision === false ? t('models.visionNote') : lede
  }

  /* the key form, under a row being connected or having its key replaced */
  const keyForm = (kind: ModelAccountKind, placeholder: string) => (
    <>
      <p className="leading-[1.55]">{t('models.keyStoredNote')}</p>
      <div className="mt-[10px] flex gap-2 max-md:flex-col">
        <Input
          className={cn(maInput, 'flex-1')}
          value={apiKey}
          onChange={(e) => typeKey(e.target.value)}
          aria-invalid={!!errorFor(kind)}
          aria-describedby={errorFor(kind) ? `${kind}-key-error` : undefined}
          placeholder={placeholder}
          type="password"
          aria-label={t('models.apiKeyAria')}
          autoFocus
          spellCheck={false}
        />
        <Button variant="primary" className={rowBtn} onClick={() => void saveKey()} disabled={busy || !apiKey.trim()}>
          {busy ? t('models.saving') : t('models.saveKey')}
        </Button>
      </div>
      <FieldError id={`${kind}-key-error`}>{errorFor(kind)}</FieldError>
    </>
  )

  const keyRow = (cfg: {
    kind: Exclude<ModelAccountKind, 'chatgpt'>
    title: string
    /** the card's one line, before it is connected */
    short: string
    mark: ReactNode
    placeholder: string
  }): Entry => {
    const account = accountOf(cfg.kind)
    const entering = showKey === cfg.kind
    const catalogError = account ? catalogs[cfg.kind]?.error : undefined
    const openKeyForm = () => {
      setApiKey('')
      setError('')
      setShowKey(cfg.kind)
    }
    if (!account) {
      return {
        connected: false,
        node: (
          <AvailableRow
            key={cfg.kind}
            mark={cfg.mark}
            name={cfg.title}
            sub={cfg.short}
            action={
              entering ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setShowKey(false)
                    setError('')
                  }}
                >
                  {t('common.cancel')}
                </Button>
              ) : (
                <Button size="sm" onClick={openKeyForm} disabled={busy}>
                  {t('models.connect')}
                </Button>
              )
            }
            panel={keyForm(cfg.kind, cfg.placeholder)}
            open={entering}
          />
        ),
      }
    }
    return {
      connected: true,
      node: (
        <Fragment key={cfg.kind}>
          <ConnectionRow
            mark={cfg.mark}
            name={cfg.title}
            sub={catalogError ?? subFor(cfg.kind, cfg.short)}
            state={account.enabled ? 'on' : 'off'}
            isDefault={view.default === cfg.kind}
            busy={busy}
            model={modelCell(cfg.kind, cfg.title)}
            onToggle={(on) => void toggle(cfg.kind, on)}
            onMakeDefault={() => void makeDefault(cfg.kind)}
            onDisconnect={() => void remove(cfg.kind)}
            menuItems={[{ label: t('models.replaceKey'), onSelect: openKeyForm }]}
            error={entering ? undefined : errorFor(cfg.kind)}
          />
          {entering && (
            <Modal size="sm" onClose={() => setShowKey(false)}>
              <ModalTitle>{t('models.replaceKeyTitle', { name: cfg.title })}</ModalTitle>
              <ModalLede>{t('models.keyStoredNote')}</ModalLede>
              <Input
                className={cn(maInput, 'mt-5 w-full')}
                value={apiKey}
                onChange={(e) => typeKey(e.target.value)}
                placeholder={cfg.placeholder}
                type="password"
                aria-label={t('models.apiKeyAria')}
                aria-invalid={!!errorFor(cfg.kind)}
                aria-describedby={errorFor(cfg.kind) ? `${cfg.kind}-replace-error` : undefined}
                autoFocus
                spellCheck={false}
              />
              <FieldError id={`${cfg.kind}-replace-error`}>{errorFor(cfg.kind)}</FieldError>
              <ModalActions>
                <Button variant="ghost" onClick={() => setShowKey(false)}>
                  {t('common.cancel')}
                </Button>
                <Button variant="primary" onClick={() => void saveKey()} disabled={busy || !apiKey.trim()}>
                  {busy ? t('models.saving') : t('models.replaceKey')}
                </Button>
              </ModalActions>
            </Modal>
          )}
        </Fragment>
      ),
    }
  }

  const chatgpt = accountOf('chatgpt')
  /* the ChatGPT sign-in, under its row while it is under way */
  const chatgptFlow = device ? (
    <>
      <ol className={maSteps}>
        <li>
          {t('models.deviceStep1Before')}
          <b>{t('models.deviceStep1Bold')}</b>
          {t('models.deviceStep1After')}
        </li>
        <li>
          {t('models.deviceStep2Before')}{' '}
          <a href={device.verificationUrl} target="_blank" rel="noreferrer noopener">
            {device.verificationUrl.replace(/^https:\/\//, '')}
          </a>{' '}
          {t('models.deviceStep2After')}
        </li>
      </ol>
      <CodeBlock text={device.userCode} />
      <p className={maWaiting}>
        <Dot className="animate-[arrival-pulse_1.6s_ease-in-out_infinite] bg-brand" /> {t('models.waitingApproval')}
      </p>
      <div className={maActions}>
        <Button asChild variant="primary" className={rowBtn}>
          <a href={device.verificationUrl} target="_blank" rel="noreferrer noopener">
            {t('models.openVerificationPage')}
          </a>
        </Button>
      </div>
      <Button variant="bare" size="sm" className={maToggle} onClick={usePasteFlow} disabled={busy}>
        {t('models.useBrowserSignIn')}
      </Button>
    </>
  ) : waiting ? (
    <>
      {/* Doop holds the loopback port itself, so approving is the whole job —
          this row flips on its own. */}
      <p className={cn(maWaiting, 'mt-0')}>
        <Dot className="animate-[arrival-pulse_1.6s_ease-in-out_infinite] bg-brand" /> {t('models.waitingOtherTab')}
      </p>
      <div className={maActions}>
        <Button asChild variant="ghost" className={rowBtn}>
          <a href={authUrl} target="_blank" rel="noreferrer noopener">
            {t('models.reopenSignIn')}
          </a>
        </Button>
        <Button variant="bare" size="sm" className={cn(maToggle, 'mt-0 underline')} onClick={() => setWaiting(false)}>
          {t('models.pasteRedirectInstead')}
        </Button>
      </div>
    </>
  ) : authUrl ? (
    <>
      <ol className={maSteps}>
        <li>{t('models.pasteStep1')}</li>
        <li>
          {t('models.pasteStep2Before')}
          <code>localhost:1455</code>
          {t('models.pasteStep2Middle')}
          <b>{t('models.pasteStep2Bold')}</b>
          {t('models.pasteStep2After')}
        </li>
        <li>{t('models.pasteStep3')}</li>
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
        <Button variant="primary" className={rowBtn} onClick={() => void finish()} disabled={busy || !redirect.trim()}>
          {busy ? t('models.connecting') : t('models.finishConnecting')}
        </Button>
        <Button asChild variant="ghost" className={rowBtn}>
          <a href={authUrl} target="_blank" rel="noreferrer noopener">
            {t('models.reopenSignIn')}
          </a>
        </Button>
      </div>
    </>
  ) : undefined
  const signingIn = !!device || waiting || !!authUrl
  const cancelSignIn = () => {
    setError('')
    if (device) cancelDevice()
    setAuthUrl('')
    setWaiting(false)
  }

  /* the Plan is connected when this desktop may run it; a browser never can */
  const planConnected = desktop && !!localState.native?.connected && !!localState.native.enabled
  /* the Plan's own row tells the pane when it switched on or became default */
  const planRowProps = {
    isDefault: view.default === 'claude-local',
    onMakeDefault: () => void makeDefault('claude-local'),
    onChange: refresh,
  }

  const entries: Entry[] = []
  if (view.chatgptEnabled !== false) {
    entries.push(
      chatgpt
        ? {
            connected: true,
            node: (
              <ConnectionRow
                key="chatgpt"
                mark={<AppIcon brand="openai" />}
                name={t('models.chatgptName')}
                sub={
                  chatgpt.plan ? `${t('models.chatgptShort')} · ${planName(chatgpt.plan)}` : t('models.chatgptShort')
                }
                state={chatgpt.enabled ? 'on' : 'off'}
                isDefault={view.default === 'chatgpt'}
                busy={busy}
                model={modelCell('chatgpt', t('models.chatgptName'))}
                onToggle={(on) => void toggle('chatgpt', on)}
                onMakeDefault={() => void makeDefault('chatgpt')}
                onDisconnect={() => void remove('chatgpt')}
                error={errorFor('chatgpt')}
              />
            ),
          }
        : {
            connected: false,
            node: (
              <AvailableRow
                key="chatgpt"
                mark={<AppIcon brand="openai" />}
                name={t('models.chatgptName')}
                sub={t('models.chatgptShort')}
                action={
                  signingIn ? (
                    <Button size="sm" variant="ghost" onClick={cancelSignIn}>
                      {t('common.cancel')}
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => void start()} disabled={busy}>
                      {t('models.connect')}
                    </Button>
                  )
                }
                panel={
                  chatgptFlow || errorFor('chatgpt') ? (
                    <>
                      {chatgptFlow}
                      <FieldError>{errorFor('chatgpt')}</FieldError>
                    </>
                  ) : undefined
                }
                open={signingIn || !!errorFor('chatgpt')}
              />
            ),
          },
    )
  }
  entries.push(
    keyRow({
      kind: 'openai-key',
      title: t('models.openaiKeyTitle'),
      short: t('models.openaiKeyShort'),
      mark: <AppIcon brand="openai" />,
      placeholder: 'sk-…',
    }),
    keyRow({
      kind: 'openrouter-key',
      title: t('models.openrouterKeyTitle'),
      short: t('models.openrouterKeyShort'),
      mark: <AppIcon brand="openrouter" />,
      placeholder: 'sk-or-…',
    }),
    keyRow({
      kind: 'gemini-key',
      title: t('models.geminiKeyTitle'),
      short: t('models.geminiKeyShort'),
      mark: <AppIcon brand="gemini" />,
      placeholder: 'AIza…',
    }),
    /* the Plan's row decides for itself whether it is a row or a card; the
       pane only needs to know which part it belongs in */
    { connected: planConnected, node: <LocalClaudeRow key="claude-local" {...planRowProps} /> },
    keyRow({
      kind: 'anthropic-key',
      title: t('models.claudeKeyTitle'),
      short: t('models.claudeKeyShort'),
      mark: <AppIcon brand="claude" />,
      placeholder: 'sk-ant-…',
    }),
  )
  const connected = entries.filter((entry) => entry.connected)
  const unconnected = entries.filter((entry) => !entry.connected)

  return (
    <div className="mt-4 flex flex-col gap-7 sm:mt-5">
      {connected.length > 0 ? (
        <ConnectionSection title={t('models.connectedTitle')}>{connected.map((entry) => entry.node)}</ConnectionSection>
      ) : (
        <p className="ml-1 text-body text-ink-soft">{t('models.noConnections')}</p>
      )}
      {unconnected.length > 0 && (
        <ConnectionSection title={t('models.addConnection')}>
          {unconnected.map((entry) => entry.node)}
        </ConnectionSection>
      )}
      {error && !errorAt && (
        <p role="alert" className="ml-1 text-body text-accent-ink">
          {error}
        </p>
      )}
    </div>
  )
}
