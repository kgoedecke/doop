import { useState } from 'react'
import type { AgentModelOption, ModelAccountKind } from '../lib/api'
import { api } from '../lib/api'
import { posthog } from '../lib/posthog'
import { navigate } from '../App'
import { cn } from '@/lib/utils'
import { AgentIcon } from './AgentIcon'
import { DoopMark } from './Logo'
import { useModelAccount } from './ModelAccount'
import { authClient } from '../lib/auth'
import { hasLocalClaude, selectLocalAgent, useLocalAgent } from '../lib/localAgent'
import { CLAUDE_MODELS, normalizeClaudeModel } from '../../shared/localAgent'
import {
  DropdownMenu,
  DropdownMenuCaption,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { MenuButton } from './ui/menu-button'

/* the brand mark each provider's models wear in the picker */
const PROVIDER_MARK: Partial<Record<ModelAccountKind, string>> = {
  chatgpt: 'gpt',
  'openai-key': 'gpt',
  'anthropic-key': 'claude',
}

/** Choose the active provider's model in the composer; Settings manages connections. */
export function ModelPicker({ disabled = false }: { disabled?: boolean }) {
  const { account, set, refresh } = useModelAccount()
  const [busy, setBusy] = useState(false)
  const { data: session } = authClient.useSession()
  const { preference, running } = useLocalAgent()
  const local = preference?.enabled ?? false
  const selectedModel = local ? normalizeClaudeModel(preference?.model) : account?.model
  const kind = account?.connected ? account.kind : undefined
  const menu: AgentModelOption[] = local ? CLAUDE_MODELS : ((kind && account?.menus?.[kind]) ?? [])
  const current = menu.find((m) => m.id === selectedModel)
  const label = current?.name ?? (account?.connected ? (account.model ?? 'Model') : 'Doop Agent')
  const mark = local ? 'claude' : kind ? PROVIDER_MARK[kind] : undefined

  async function pick(model: string) {
    if (model === selectedModel) return
    setBusy(true)
    try {
      if (local) {
        const option = CLAUDE_MODELS.find((entry) => entry.id === model)
        if (!option || !session?.user.id) return
        await selectLocalAgent(session.user.id, { enabled: true, model: option.id })
      } else {
        set(await api.setAgentModel(model))
      }
      posthog.capture('agent_model_changed', { model, via: 'composer' })
    } catch (e) {
      console.error(e)
      refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <MenuButton
          variant="quiet"
          disabled={disabled || busy || !account || (local && (running || !hasLocalClaude() || !session?.user.id))}
          aria-label={`Model: ${label}`}
          className={cn('min-w-0 flex-initial gap-[5px]', busy && 'animate-[stream-pulse_1.2s_ease-in-out_infinite]')}
          icon={
            <span className="grid size-3 flex-none place-items-center">
              {mark ? (
                <AgentIcon name={mark} size={12} />
              ) : (
                /* no provider behind it: the agent's own mark */
                <DoopMark size={11} className="block" />
              )}
            </span>
          }
        >
          <span className="truncate">{label}</span>
        </MenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" width="lg">
        {!local && account?.modelCatalogWarning && (
          <DropdownMenuCaption>{account.modelCatalogWarning}</DropdownMenuCaption>
        )}
        {menu.length > 0 ? (
          <>
            <DropdownMenuCaption>Doop Agent model</DropdownMenuCaption>
            <DropdownMenuRadioGroup value={selectedModel ?? ''} onValueChange={(model) => void pick(model)}>
              {menu.map((m) => (
                <DropdownMenuRadioItem
                  key={m.id}
                  value={m.id}
                  description={
                    m.vision === false
                      ? `${m.blurb} Text-only: this model can’t see screenshots, so designs aren’t visually reviewed.`
                      : m.blurb
                  }
                >
                  {m.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        ) : (
          <DropdownMenuCaption className="pb-2 text-ink-soft">
            {account?.connected
              ? 'No compatible models are available from this account right now.'
              : 'No model account connected — the Doop Agent runs on the server’s model when one is set up.'}
          </DropdownMenuCaption>
        )}
        <DropdownMenuItem onSelect={() => navigate('/settings?pane=agent')}>
          {account?.connected || local ? 'Manage providers…' : 'Connect a provider…'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
