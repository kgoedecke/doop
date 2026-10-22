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
import { CLAUDE_MODELS, isClaudeModel, normalizeClaudeModel } from '../../shared/localAgent'
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
import { Modal, ModalTitle, ModalLede, ModalActions } from './ui/modal'
import { Input } from './ui/input'
import { Button } from './ui/button'

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
  const [menuOpen, setMenuOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [customModel, setCustomModel] = useState('')
  const [error, setError] = useState('')
  const { data: session } = authClient.useSession()
  const { preference, native, running } = useLocalAgent()
  const local = preference?.enabled ?? false
  let selectedModel = account?.model
  if (local)
    selectedModel = native?.customProfile ? (native.model ?? 'default') : normalizeClaudeModel(preference?.model)
  const kind = account?.connected ? account.kind : undefined
  const menu: AgentModelOption[] = local ? (native?.models ?? CLAUDE_MODELS) : ((kind && account?.menus?.[kind]) ?? [])
  const current = menu.find((m) => m.id === selectedModel)
  let label = current?.name
  if (!label) {
    if (local) label = selectedModel === 'default' ? 'Claude Code default' : selectedModel
    else label = account?.connected ? (account.model ?? 'Model') : 'Doop Agent'
  }
  if (local && !hasLocalClaude()) label = 'Desktop model'
  const mark = local ? 'claude' : kind ? PROVIDER_MARK[kind] : undefined

  async function pick(model: string) {
    if (model === selectedModel) return true
    setError('')
    setBusy(true)
    try {
      if (local) {
        if (!session?.user.id) throw new Error('Sign in to Doop before choosing a model.')
        if (!isClaudeModel(model)) throw new Error('Enter a valid model or deployment ID.')
        await selectLocalAgent(session.user.id, { enabled: true, model })
      } else {
        set(await api.setAgentModel(model))
      }
      posthog.capture('agent_model_changed', {
        model: local && native?.customProfile ? 'custom' : model,
        via: 'composer',
      })
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      refresh()
      return false
    } finally {
      setBusy(false)
    }
  }

  function closeCustomModel() {
    if (busy) return
    setCustomOpen(false)
    setError('')
  }

  return (
    <>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open)
          setError('')
        }}
      >
        <DropdownMenuTrigger asChild>
          <MenuButton
            variant="quiet"
            disabled={disabled || busy || !account || (local && (running || !hasLocalClaude() || !session?.user.id))}
            aria-label={`Model: ${label}`}
            className={cn(
              'min-w-0 flex-initial gap-[5px]',
              local && 'ph-no-capture',
              busy && 'animate-[stream-pulse_1.2s_ease-in-out_infinite]',
            )}
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
        <DropdownMenuContent side="top" align="end" width="lg" className={local ? 'ph-no-capture' : undefined}>
          {error && <DropdownMenuCaption>{error}</DropdownMenuCaption>}
          {local && native?.modelWarning && <DropdownMenuCaption>{native.modelWarning}</DropdownMenuCaption>}
          {!local && account?.modelCatalogWarning && (
            <DropdownMenuCaption>{account.modelCatalogWarning}</DropdownMenuCaption>
          )}
          {menu.length > 0 ? (
            <>
              <DropdownMenuCaption>Doop Agent model</DropdownMenuCaption>
              <DropdownMenuRadioGroup
                value={selectedModel ?? ''}
                onValueChange={(model) => {
                  void pick(model).then((saved) => {
                    if (saved) setMenuOpen(false)
                  })
                }}
              >
                {menu.map((m) => (
                  <DropdownMenuRadioItem
                    key={m.id}
                    value={m.id}
                    disabled={busy}
                    onSelect={(event) => event.preventDefault()}
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
              {local
                ? 'No models were loaded from Claude Code. Check its configuration and Refresh the connection in Settings.'
                : account?.connected
                  ? 'No compatible models are available from this account right now.'
                  : 'No model account connected — the Doop Agent runs on the server’s model when one is set up.'}
            </DropdownMenuCaption>
          )}
          {local && native?.customProfile && (
            <DropdownMenuItem
              onSelect={() => {
                setError('')
                setCustomModel('')
                setCustomOpen(true)
              }}
            >
              Use a custom model…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => navigate('/settings?pane=agent')}>
            {account?.connected || local ? 'Manage providers…' : 'Connect a provider…'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {customOpen && (
        <Modal size="sm" onClose={closeCustomModel} className="ph-no-capture">
          <ModalTitle>Use a custom model</ModalTitle>
          <ModalLede>
            Enter the model or deployment ID your Claude Code provider accepts. It must support tool calls and images to
            work with Doop.
          </ModalLede>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void pick(customModel.trim()).then((saved) => {
                if (saved) setCustomOpen(false)
              })
            }}
          >
            <label htmlFor="claude-custom-model" className="mt-4 block text-body">
              Model or deployment ID
            </label>
            <Input
              id="claude-custom-model"
              className="mt-2"
              value={customModel}
              onChange={(event) => setCustomModel(event.target.value)}
              autoFocus
            />
            {error && (
              <p role="alert" className="mt-2 text-body text-accent-ink">
                {error}
              </p>
            )}
            <ModalActions>
              <Button type="button" variant="ghost" disabled={busy} onClick={closeCustomModel}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !isClaudeModel(customModel.trim())}>
                Use model
              </Button>
            </ModalActions>
          </form>
        </Modal>
      )}
    </>
  )
}
