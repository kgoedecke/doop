import { useEffect, useState } from 'react'
import { api, errorMessage } from '../lib/api'
import { posthog } from '../lib/posthog'
import { timeAgo } from '../lib/time'
import { WEBHOOK_EVENTS, type WebhookEventType, type WebhookInfo } from '../../shared/webhooks'
import { t as translate, useT, type PlainMessageKey, type Translate } from '../lib/i18n'
import { ConfirmDialog } from './ui/alert-dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Note } from './ui/note'
import { Checkbox } from './ui/checkbox'
import { CodeBlock } from './ui/code-block'
import { CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from './ui/card'
import { TrashIcon } from './ui/icons'

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** What each event means, in the reader's language. The event names stay as
 *  they are — receivers match on them — and the shared English labels stay
 *  with the server. */
const EVENT_LABELS: Record<WebhookEventType, PlainMessageKey> = {
  'comment.created': 'webhooks.eventCommentCreated',
  'comment.replied': 'webhooks.eventCommentReplied',
  'comment.resolved': 'webhooks.eventCommentResolved',
  'frame.created': 'webhooks.eventFrameCreated',
  'task.completed': 'webhooks.eventTaskCompleted',
  'task.failed': 'webhooks.eventTaskFailed',
}

/** The one-line health of a hook, phrased for a person. */
function health(hook: WebhookInfo, t: Translate): { text: string; tone?: 'error' | 'success' } {
  /* a paused hook's reason is the server's own text */
  if (!hook.enabled && hook.lastError?.startsWith('paused')) return { text: hook.lastError, tone: 'error' }
  if (!hook.enabled) return { text: t('webhooks.healthOff') }
  if (!hook.lastAt) return { text: t('webhooks.healthNoDeliveries') }
  if (hook.failures) {
    return {
      text: t('webhooks.healthFailing', {
        count: hook.failures,
        when: timeAgo(hook.lastAt),
        error: hook.lastError ?? t('webhooks.healthFailed'),
      }),
      tone: 'error',
    }
  }
  return {
    text: t('webhooks.healthDelivered', { when: timeAgo(hook.lastAt), status: String(hook.lastStatus) }),
    tone: 'success',
  }
}

/** Picks events with their labels; used for the new-hook form. */
function EventPicker({ value, onChange }: { value: WebhookEventType[]; onChange: (next: WebhookEventType[]) => void }) {
  const t = useT()
  return (
    <div className="grid gap-1.5 sm:grid-cols-2">
      {WEBHOOK_EVENTS.map((event) => {
        const on = value.includes(event)
        return (
          <label key={event} className="relative flex cursor-pointer items-center gap-2 text-body text-ink">
            <Checkbox
              checked={on}
              onChange={() => onChange(on ? value.filter((e) => e !== event) : [...value, event])}
              aria-label={t(EVENT_LABELS[event])}
            />
            <span>
              <code className="font-mono text-caption text-ink-soft">{event}</code>
              <span className="text-ink-faint"> · {t(EVENT_LABELS[event])}</span>
            </span>
          </label>
        )
      })}
    </div>
  )
}

/** The "Webhooks" pane of /settings: register URLs doop POSTs canvas events
 *  to, see whether they answer, rotate their secrets. The secret appears once,
 *  on creation or rotation — the list never carries it. */
export function Webhooks() {
  const t = useT()
  const [hooks, setHooks] = useState<WebhookInfo[] | null>(null)
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<WebhookEventType[]>([...WEBHOOK_EVENTS])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  /* the one moment a secret exists client-side */
  const [secret, setSecret] = useState<{ id: string; secret: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  /* the action awaiting "are you sure" — an in-app dialog, since
     window.confirm is a silent "cancel" in the desktop shell's webview */
  const [confirming, setConfirming] = useState<{ kind: 'rotate' | 'remove'; hook: WebhookInfo } | null>(null)
  const [rowNote, setRowNote] = useState<Record<string, { text: string; tone?: 'error' | 'success' }>>({})

  useEffect(() => {
    api.listWebhooks().then(setHooks, (e: unknown) => {
      console.error(e)
      setHooks([])
      /* the free translator: the effect runs once, and useT's `t` is new every render */
      setError(errorMessage(e, translate('webhooks.loadFailed')))
    })
  }, [])

  function replace(next: WebhookInfo) {
    setHooks((current) => current?.map((h) => (h.id === next.id ? next : h)) ?? null)
  }

  async function create() {
    setSaving(true)
    setError('')
    try {
      const { secret: fresh, ...info } = await api.createWebhook({ url: url.trim(), events })
      posthog.capture('webhook_created', { events })
      setUrl('')
      setSecret({ id: info.id, secret: fresh })
      setHooks((current) => [info, ...(current ?? [])])
    } catch (e) {
      setError(errorMessage(e, t('webhooks.createFailed')))
    } finally {
      setSaving(false)
    }
  }

  async function act(hook: WebhookInfo, work: () => Promise<void>, failure: string) {
    setBusy(hook.id)
    try {
      await work()
    } catch (e) {
      setRowNote((n) => ({ ...n, [hook.id]: { text: errorMessage(e, failure), tone: 'error' } }))
    } finally {
      setBusy(null)
    }
  }

  const test = (hook: WebhookInfo) =>
    act(
      hook,
      async () => {
        const result = await api.testWebhook(hook.id)
        setRowNote((n) => ({
          ...n,
          [hook.id]: result.ok
            ? { text: t('webhooks.pingAnswered', { status: String(result.status) }), tone: 'success' }
            : {
                text: t('webhooks.pingFailed', { error: result.error ?? t('webhooks.pingNoResponse') }),
                tone: 'error',
              },
        }))
        const fresh = await api.listWebhooks()
        setHooks(fresh)
      },
      t('webhooks.testFailed'),
    )

  const toggle = (hook: WebhookInfo) =>
    act(
      hook,
      async () => replace(await api.updateWebhook(hook.id, { enabled: !hook.enabled })),
      t('webhooks.toggleFailed'),
    )

  const rotate = (hook: WebhookInfo) =>
    act(
      hook,
      async () => {
        const { secret: fresh } = await api.rotateWebhookSecret(hook.id)
        posthog.capture('webhook_secret_rotated')
        setSecret({ id: hook.id, secret: fresh })
      },
      t('webhooks.rotateFailed'),
    )

  const remove = (hook: WebhookInfo) =>
    act(
      hook,
      async () => {
        await api.deleteWebhook(hook.id)
        posthog.capture('webhook_deleted')
        setHooks((current) => current?.filter((h) => h.id !== hook.id) ?? null)
        if (secret?.id === hook.id) setSecret(null)
      },
      t('webhooks.removeFailed'),
    )

  return (
    <SettingsCard>
      <CardHeader>
        <CardTitle>{t('webhooks.title')}</CardTitle>
        <CardDescription>
          {t('webhooks.descriptionBefore')}
          <code className="font-mono text-label">X-Doop-Signature</code>
          {t('webhooks.descriptionAfter')}
        </CardDescription>
      </CardHeader>

      <CardRow
        label={t('webhooks.newWebhookRow')}
        action={
          <Button size="sm" disabled={saving || hooks === null || !url.trim() || !events.length} onClick={create}>
            {saving ? t('webhooks.adding') : t('webhooks.addWebhook')}
          </Button>
        }
        controlWidth="lg"
        control={
          <Input
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              setError('')
            }}
            placeholder="https://hooks.example.com/doop"
            inputMode="url"
            aria-label={t('webhooks.urlAria')}
          />
        }
      >
        {/* basis-full drops the picker onto its own line under the URL field */}
        <div className="min-w-0 basis-full">
          <EventPicker value={events} onChange={setEvents} />
          {error && <Note tone="error">{error}</Note>}
        </div>
      </CardRow>

      {secret && (
        <CardRow label={t('webhooks.signingSecretRow')}>
          <div className="min-w-0 flex-1">
            <Note tone="success">{t('webhooks.copyNow')}</Note>
            <CodeBlock className="mt-2" text={secret.secret} />
            <Note>{t('webhooks.signatureFormula')}</Note>
          </div>
        </CardRow>
      )}

      {hooks?.map((hook) => {
        const status = rowNote[hook.id] ?? health(hook, t)
        return (
          <CardRow
            key={hook.id}
            label={hostOf(hook.url)}
            action={
              <div className="flex flex-wrap items-center gap-1">
                <Button size="sm" variant="ghost" disabled={busy === hook.id} onClick={() => void test(hook)}>
                  {t('webhooks.sendTest')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy === hook.id}
                  onClick={() => setConfirming({ kind: 'rotate', hook })}
                >
                  {t('webhooks.rotateSecret')}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy === hook.id} onClick={() => void toggle(hook)}>
                  {hook.enabled ? t('webhooks.turnOff') : t('webhooks.turnOn')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy === hook.id}
                  aria-label={t('webhooks.removeAria', { host: hostOf(hook.url) })}
                  onClick={() => setConfirming({ kind: 'remove', hook })}
                >
                  <TrashIcon /> {t('webhooks.remove')}
                </Button>
              </div>
            }
          >
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-body text-ink-soft" title={hook.url}>
                {hook.url}
              </div>
              <div className="mt-1 text-caption text-ink-faint">{hook.events.join(' · ')}</div>
              <Note tone={status.tone}>{status.text}</Note>
            </div>
          </CardRow>
        )
      })}
      {hooks && hooks.length === 0 && !secret && (
        <CardRow label={t('webhooks.noWebhooksRow')}>
          <Note>{t('webhooks.noWebhooksNote')}</Note>
        </CardRow>
      )}
      <ConfirmDialog
        open={!!confirming}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={
          confirming?.kind === 'rotate'
            ? t('webhooks.rotateConfirmTitle', { host: confirming ? hostOf(confirming.hook.url) : '' })
            : t('webhooks.removeConfirmTitle', { host: confirming ? hostOf(confirming.hook.url) : '' })
        }
        description={confirming?.kind === 'rotate' ? t('webhooks.rotateConfirmDescription') : undefined}
        confirmLabel={confirming?.kind === 'rotate' ? t('webhooks.rotateSecret') : t('webhooks.removeWebhook')}
        destructive
        onConfirm={() => {
          const target = confirming
          setConfirming(null)
          if (target) void (target.kind === 'rotate' ? rotate(target.hook) : remove(target.hook))
        }}
      />
    </SettingsCard>
  )
}
