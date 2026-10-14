import { useEffect, useState } from 'react'
import { api, errorMessage } from '../lib/api'
import { posthog } from '../lib/posthog'
import { timeAgo } from '../lib/time'
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_LABELS, type WebhookEventType, type WebhookInfo } from '../../shared/webhooks'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Note } from './ui/note'
import { Checkbox } from './ui/checkbox'
import { CodeBlock } from './ui/code-block'
import { Card, CardDescription, CardHeader, CardRow, CardTitle } from './ui/card'
import { TrashIcon } from './ui/icons'

const settingsCard = 'mt-4 max-w-[1000px] overflow-hidden sm:mt-5'
const settingsInput = 'w-full sm:w-[420px]'

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** The one-line health of a hook, phrased for a person. */
function health(hook: WebhookInfo): { text: string; tone?: 'error' | 'success' } {
  if (!hook.enabled && hook.lastError?.startsWith('paused')) return { text: hook.lastError, tone: 'error' }
  if (!hook.enabled) return { text: 'off — nothing is sent' }
  if (!hook.lastAt) return { text: 'no deliveries yet — send a test' }
  if (hook.failures) {
    return {
      text: `${hook.failures} failed in a row · last ${timeAgo(hook.lastAt)}: ${hook.lastError ?? 'failed'}`,
      tone: 'error',
    }
  }
  return { text: `delivered ${timeAgo(hook.lastAt)} (HTTP ${hook.lastStatus})`, tone: 'success' }
}

/** Picks events with the shared labels; used for the new-hook form. */
function EventPicker({ value, onChange }: { value: WebhookEventType[]; onChange: (next: WebhookEventType[]) => void }) {
  return (
    <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
      {WEBHOOK_EVENTS.map((event) => {
        const on = value.includes(event)
        return (
          <label key={event} className="relative flex cursor-pointer items-center gap-2 text-[12.5px] text-ink">
            <Checkbox
              checked={on}
              onChange={() => onChange(on ? value.filter((e) => e !== event) : [...value, event])}
              aria-label={WEBHOOK_EVENT_LABELS[event]}
            />
            <span>
              <code className="font-mono text-[11.5px] text-ink-soft">{event}</code>
              <span className="text-ink-faint"> · {WEBHOOK_EVENT_LABELS[event]}</span>
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
  const [hooks, setHooks] = useState<WebhookInfo[] | null>(null)
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<WebhookEventType[]>([...WEBHOOK_EVENTS])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  /* the one moment a secret exists client-side */
  const [secret, setSecret] = useState<{ id: string; secret: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [rowNote, setRowNote] = useState<Record<string, { text: string; tone?: 'error' | 'success' }>>({})

  useEffect(() => {
    api.listWebhooks().then(setHooks, (e: unknown) => {
      console.error(e)
      setHooks([])
      setError(errorMessage(e, 'Your webhooks could not be loaded'))
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
      setError(errorMessage(e, 'That webhook could not be created'))
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
            ? { text: `ping answered with HTTP ${result.status}`, tone: 'success' }
            : { text: `ping failed: ${result.error ?? 'no response'}`, tone: 'error' },
        }))
        const fresh = await api.listWebhooks()
        setHooks(fresh)
      },
      'The test could not be sent',
    )

  const toggle = (hook: WebhookInfo) =>
    act(
      hook,
      async () => replace(await api.updateWebhook(hook.id, { enabled: !hook.enabled })),
      'That could not be saved',
    )

  const rotate = (hook: WebhookInfo) =>
    act(
      hook,
      async () => {
        if (
          !window.confirm(
            `Rotate the secret for ${hostOf(hook.url)}? Deliveries signed with the old one stop verifying.`,
          )
        )
          return
        const { secret: fresh } = await api.rotateWebhookSecret(hook.id)
        posthog.capture('webhook_secret_rotated')
        setSecret({ id: hook.id, secret: fresh })
      },
      'The secret could not be rotated',
    )

  const remove = (hook: WebhookInfo) =>
    act(
      hook,
      async () => {
        if (!window.confirm(`Remove the webhook for ${hostOf(hook.url)}?`)) return
        await api.deleteWebhook(hook.id)
        posthog.capture('webhook_deleted')
        setHooks((current) => current?.filter((h) => h.id !== hook.id) ?? null)
        if (secret?.id === hook.id) setSecret(null)
      },
      'That webhook could not be removed',
    )

  return (
    <Card className={settingsCard}>
      <CardHeader>
        <CardTitle>Webhooks</CardTitle>
        <CardDescription>
          doop POSTs a signed JSON event to each URL below when something happens on a canvas you own, were invited to,
          or that lives in one of your workspaces — route it to Slack, n8n, an issue tracker, anything with an HTTP
          endpoint. Each delivery carries an <code className="font-mono text-[12px]">X-Doop-Signature</code> header
          (HMAC-SHA256 with the webhook’s secret) so the receiver can trust it. Failed deliveries are retried three
          times; a hook that keeps failing pauses itself.
        </CardDescription>
      </CardHeader>

      <CardRow
        label="New webhook"
        action={
          <Button size="sm" disabled={saving || hooks === null || !url.trim() || !events.length} onClick={create}>
            {saving ? 'Adding…' : 'Add webhook'}
          </Button>
        }
      >
        <div className="min-w-0 flex-1">
          <Input
            className={settingsInput}
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              setError('')
            }}
            placeholder="https://hooks.example.com/doop"
            inputMode="url"
            aria-label="Webhook URL"
          />
          <EventPicker value={events} onChange={setEvents} />
          {error && <Note tone="error">{error}</Note>}
        </div>
      </CardRow>

      {secret && (
        <CardRow label="Signing secret">
          <div className="min-w-0 flex-1">
            <Note tone="success">Copy it now — it is shown once. Verify deliveries with it on your side.</Note>
            <CodeBlock className="mt-2" text={secret.secret} />
            <Note>
              signature = “sha256=” + HMAC-SHA256(secret, X-Doop-Timestamp + “.” + raw body). The docs have a ready-made
              check.
            </Note>
          </div>
        </CardRow>
      )}

      {hooks?.map((hook) => {
        const status = rowNote[hook.id] ?? health(hook)
        return (
          <CardRow
            key={hook.id}
            label={hostOf(hook.url)}
            action={
              <div className="flex flex-wrap items-center gap-1">
                <Button size="sm" variant="ghost" disabled={busy === hook.id} onClick={() => void test(hook)}>
                  Send test
                </Button>
                <Button size="sm" variant="ghost" disabled={busy === hook.id} onClick={() => void rotate(hook)}>
                  Rotate secret
                </Button>
                <Button size="sm" variant="ghost" disabled={busy === hook.id} onClick={() => void toggle(hook)}>
                  {hook.enabled ? 'Turn off' : 'Turn on'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy === hook.id}
                  aria-label={`Remove webhook for ${hostOf(hook.url)}`}
                  onClick={() => void remove(hook)}
                >
                  <TrashIcon /> Remove
                </Button>
              </div>
            }
          >
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[12.5px] text-ink-soft" title={hook.url}>
                {hook.url}
              </div>
              <div className="mt-1 text-[11.5px] text-ink-faint">{hook.events.join(' · ')}</div>
              <Note tone={status.tone}>{status.text}</Note>
            </div>
          </CardRow>
        )
      })}
      {hooks && hooks.length === 0 && !secret && (
        <CardRow label="No webhooks yet">
          <Note>Add one above — a quick way to try it is an n8n Webhook node or a request bin.</Note>
        </CardRow>
      )}
    </Card>
  )
}
