import { useEffect, useState } from 'react'
import { api, errorMessage, type AgentKeyInfo } from '../lib/api'
import { posthog } from '../lib/posthog'
import { timeAgo } from '../lib/time'
import { t as translate, useT } from '../lib/i18n'
import { ConfirmDialog } from './ui/alert-dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Note } from './ui/note'
import { CodeBlock } from './ui/code-block'
import { CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from './ui/card'
import { TrashIcon } from './ui/icons'

/* same fixed-column-on-desktop rhythm as the other settings cards */

/** The MCP config a headless client needs, with the key in place. Shown once,
 *  right after minting — the moment the person actually has the secret. */
function headlessConfig(secret: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        doop: { type: 'http', url: `${location.origin}/mcp`, headers: { Authorization: `Bearer ${secret}` } },
      },
    },
    null,
    2,
  )
}

/** The "Agent keys" pane of /settings: mint, list and revoke the bearer
 *  credentials headless MCP clients (Mastra, n8n, CI) connect with. The
 *  secret appears exactly once, in the mint response — after that the list
 *  knows only each key's first characters. */
export function AgentKeys() {
  const t = useT()
  const [keys, setKeys] = useState<AgentKeyInfo[] | null>(null)
  const [name, setName] = useState('')
  const [minting, setMinting] = useState(false)
  const [error, setError] = useState('')
  /* the one moment the full secret exists client-side */
  const [minted, setMinted] = useState<{ id: string; secret: string } | null>(null)
  /* the key awaiting "are you sure" — an in-app dialog, since window.confirm
     is a silent "cancel" in the desktop shell's webview */
  const [confirmRevoke, setConfirmRevoke] = useState<AgentKeyInfo | null>(null)

  /* `keys === null` is "still loading", and minting stays disabled until it
     resolves: a list request in flight would otherwise land after the key it
     doesn't know about and drop it from the list. A failed load still opens
     the pane — an empty list you can mint into beats a dead card. */
  useEffect(() => {
    api.listAgentKeys().then(setKeys, (e: unknown) => {
      console.error(e)
      setKeys([])
      /* the free translator: the effect runs once, and useT's `t` is new every render */
      setError(errorMessage(e, translate('agentKeys.loadFailed')))
    })
  }, [])

  async function mint() {
    setMinting(true)
    setError('')
    try {
      const { secret, ...info } = await api.createAgentKey(name)
      posthog.capture('agent_key_created')
      setName('')
      setMinted({ id: info.id, secret })
      setKeys((current) => [info, ...(current ?? [])])
    } catch (e) {
      setError(errorMessage(e, t('agentKeys.createFailed')))
    } finally {
      setMinting(false)
    }
  }

  async function revoke(key: AgentKeyInfo) {
    try {
      await api.deleteAgentKey(key.id)
      posthog.capture('agent_key_revoked')
      setKeys((current) => current?.filter((k) => k.id !== key.id) ?? null)
      if (minted?.id === key.id) setMinted(null)
    } catch (e) {
      setError(errorMessage(e, t('agentKeys.revokeFailed')))
    }
  }

  return (
    <SettingsCard>
      <CardHeader>
        <CardTitle>{t('agentKeys.title')}</CardTitle>
        <CardDescription>{t('agentKeys.description')}</CardDescription>
      </CardHeader>

      <CardRow
        label={t('agentKeys.newKeyRow')}
        action={
          <Button size="sm" disabled={minting || keys === null} onClick={mint}>
            {minting ? t('agentKeys.creating') : t('agentKeys.createKey')}
          </Button>
        }
        control={
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setError('')
            }}
            placeholder={t('agentKeys.namePlaceholder')}
            maxLength={60}
            aria-label={t('agentKeys.nameAria')}
          />
        }
      >
        {error && <Note tone="error">{error}</Note>}
      </CardRow>

      {minted && (
        <CardRow label={t('agentKeys.yourNewKey')}>
          <div className="min-w-0 flex-1">
            <Note tone="success">{t('agentKeys.copyNow')}</Note>
            <CodeBlock className="mt-2" text={minted.secret} />
            <p className="mb-1.5 mt-3 text-caption font-medium text-ink-faint">{t('agentKeys.headlessConfigLabel')}</p>
            <CodeBlock text={headlessConfig(minted.secret)} />
          </div>
        </CardRow>
      )}

      {keys?.map((key) => (
        <CardRow
          key={key.id}
          label={key.name}
          action={
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('agentKeys.revokeAria', { name: key.name })}
              onClick={() => setConfirmRevoke(key)}
            >
              <TrashIcon /> {t('agentKeys.revoke')}
            </Button>
          }
        >
          <span className="font-mono text-body text-ink-soft">{key.start}…</span>
          <Note>
            {key.lastUsedAt
              ? t('agentKeys.createdLastUsed', { created: timeAgo(key.createdAt), used: timeAgo(key.lastUsedAt) })
              : t('agentKeys.createdNeverUsed', { created: timeAgo(key.createdAt) })}
          </Note>
        </CardRow>
      ))}
      {keys && keys.length === 0 && !minted && (
        <CardRow label={t('agentKeys.noKeysRow')}>
          <Note>{t('agentKeys.noKeysNote')}</Note>
        </CardRow>
      )}
      <ConfirmDialog
        open={!!confirmRevoke}
        onOpenChange={(open) => !open && setConfirmRevoke(null)}
        title={t('agentKeys.revokeConfirmTitle', { name: confirmRevoke?.name ?? '' })}
        description={t('agentKeys.revokeConfirmDescription')}
        confirmLabel={t('agentKeys.revokeConfirm')}
        destructive
        onConfirm={() => {
          const target = confirmRevoke
          setConfirmRevoke(null)
          if (target) void revoke(target)
        }}
      />
    </SettingsCard>
  )
}
