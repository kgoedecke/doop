import { useEffect, useState } from 'react'
import { api, errorMessage, type AgentKeyInfo } from '../lib/api'
import { posthog } from '../lib/posthog'
import { timeAgo } from '../lib/time'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Note } from './ui/note'
import { CodeBlock } from './ui/code-block'
import { Card, CardDescription, CardHeader, CardRow, CardTitle } from './ui/card'
import { TrashIcon } from './ui/icons'

/* same fixed-column-on-desktop rhythm as the other settings cards */
const settingsCard = 'mt-4 max-w-[1000px] overflow-hidden sm:mt-5'
const settingsInput = 'w-full sm:w-[280px]'

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
  const [keys, setKeys] = useState<AgentKeyInfo[] | null>(null)
  const [name, setName] = useState('')
  const [minting, setMinting] = useState(false)
  const [error, setError] = useState('')
  /* the one moment the full secret exists client-side */
  const [minted, setMinted] = useState<{ id: string; secret: string } | null>(null)

  /* `keys === null` is "still loading", and minting stays disabled until it
     resolves: a list request in flight would otherwise land after the key it
     doesn't know about and drop it from the list. A failed load still opens
     the pane — an empty list you can mint into beats a dead card. */
  useEffect(() => {
    api.listAgentKeys().then(setKeys, (e: unknown) => {
      console.error(e)
      setKeys([])
      setError(errorMessage(e, 'Your keys could not be loaded'))
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
      setError(errorMessage(e, 'That key could not be created'))
    } finally {
      setMinting(false)
    }
  }

  async function revoke(key: AgentKeyInfo) {
    if (!window.confirm(`Revoke "${key.name}"? Agents using it lose access immediately.`)) return
    try {
      await api.deleteAgentKey(key.id)
      posthog.capture('agent_key_revoked')
      setKeys((current) => current?.filter((k) => k.id !== key.id) ?? null)
      if (minted?.id === key.id) setMinted(null)
    } catch (e) {
      setError(errorMessage(e, 'That key could not be revoked'))
    }
  }

  return (
    <Card className={settingsCard}>
      <CardHeader>
        <CardTitle>Agent keys</CardTitle>
        <CardDescription>
          Bearer credentials for the MCP endpoint, for agents that cannot open a browser to sign in — a Mastra workflow,
          n8n, CI. A key acts as you: everything it designs is attributed to you, and it reaches exactly the canvases
          you can. Revoking cuts it off immediately.
        </CardDescription>
      </CardHeader>

      <CardRow
        label="New key"
        action={
          <Button size="sm" disabled={minting || keys === null} onClick={mint}>
            {minting ? 'Creating…' : 'Create key'}
          </Button>
        }
      >
        <Input
          className={settingsInput}
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setError('')
          }}
          placeholder="What will use it, e.g. mastra-prod"
          maxLength={60}
          aria-label="Agent key name"
        />
        {error && <Note tone="error">{error}</Note>}
      </CardRow>

      {minted && (
        <CardRow label="Your new key">
          <div className="min-w-0 flex-1">
            <Note tone="success">Copy it now — it is shown once and stored hashed.</Note>
            <CodeBlock className="mt-2" text={minted.secret} />
            <p className="mb-1.5 mt-3 text-[11px] font-bold uppercase tracking-[0.14em] text-ink-faint">
              MCP config for a headless client
            </p>
            <CodeBlock text={headlessConfig(minted.secret)} />
          </div>
        </CardRow>
      )}

      {keys?.map((key) => (
        <CardRow
          key={key.id}
          label={key.name}
          action={
            <Button size="sm" variant="ghost" aria-label={`Revoke ${key.name}`} onClick={() => void revoke(key)}>
              <TrashIcon /> Revoke
            </Button>
          }
        >
          <span className="font-mono text-[13px] text-ink-soft">{key.start}…</span>
          <Note>
            created {timeAgo(key.createdAt)}
            {key.lastUsedAt ? ` · last used ${timeAgo(key.lastUsedAt)}` : ' · never used'}
          </Note>
        </CardRow>
      ))}
      {keys && keys.length === 0 && !minted && (
        <CardRow label="No keys yet">
          <Note>Interactive clients (Claude Code, Codex) don’t need one — they sign in with OAuth.</Note>
        </CardRow>
      )}
    </Card>
  )
}
