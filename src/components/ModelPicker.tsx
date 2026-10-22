import { useState } from 'react'
import type { ModelAccountKind } from '../lib/api'
import { api } from '../lib/api'
import { posthog } from '../lib/posthog'
import { navigate } from '../App'
import { cn } from '@/lib/utils'
import { AgentIcon } from './AgentIcon'
import { DoopMark } from './Logo'
import { useModelAccount } from './ModelAccount'
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

/**
 * The model the Doop Agent runs on, as a quiet dropdown beside the
 * composer's send button. It is the same per-account choice Settings → Doop
 * Agent makes (PATCH /api/model-account), offered from the connected
 * provider's curated menu. With no account connected there is nothing to
 * choose between, so it says so and links to Settings.
 */
export function ModelPicker({ disabled = false }: { disabled?: boolean }) {
  const { account, set, refresh } = useModelAccount()
  const [busy, setBusy] = useState(false)
  const kind = account?.connected ? account.kind : undefined
  const menu = (kind && account?.menus?.[kind]) ?? []
  const current = menu.find((m) => m.id === account?.model)
  const label = current?.name ?? (account?.connected ? (account.model ?? 'Model') : 'Doop Agent')
  const mark = kind ? PROVIDER_MARK[kind] : undefined

  async function pick(model: string) {
    if (model === account?.model) return
    setBusy(true)
    try {
      set(await api.setAgentModel(model))
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
          disabled={disabled || busy || !account}
          aria-label={`Model: ${label}`}
          className={cn('min-w-0 gap-[5px]', busy && 'animate-[stream-pulse_1.2s_ease-in-out_infinite]')}
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
        {account?.modelCatalogWarning && <DropdownMenuCaption>{account.modelCatalogWarning}</DropdownMenuCaption>}
        {menu.length > 0 ? (
          <>
            <DropdownMenuCaption>Doop Agent model</DropdownMenuCaption>
            <DropdownMenuRadioGroup value={account?.model ?? ''} onValueChange={(model) => void pick(model)}>
              {menu.map((m) => (
                <DropdownMenuRadioItem key={m.id} value={m.id} description={m.blurb}>
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
          {account?.connected ? 'Model settings…' : 'Connect a model…'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
