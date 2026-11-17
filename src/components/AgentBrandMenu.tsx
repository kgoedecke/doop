import { useState } from 'react'
import type { AgentBrandChoice } from '../../shared/agentBrand'
import { useAgentIdentities } from '../hooks/use-agent-identities'
import { useT } from '@/lib/i18n'
import { AgentIcon } from './AgentIcon'
import { IconButton } from './ui/icon-button'
import {
  DropdownMenu,
  DropdownMenuCaption,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

/* Automatic is the absence of a choice, so it lives outside AgentBrandChoice */
const AUTOMATIC = 'automatic'

/* The products an owner can pin their agent to, under the names they go by. */
const BRAND_OPTIONS: { value: AgentBrandChoice; label: string }[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'grok', label: 'Grok' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'github', label: 'Copilot' },
  { value: 'opencode', label: 'opencode' },
  { value: 'pi', label: 'Pi' },
  { value: 'kimi', label: 'Kimi' },
  { value: 'deepseek', label: 'DeepSeek' },
]

/** The icon its owner picked for an outside agent, on the agent's own row:
 *  the mark itself is the trigger, so the menu stays one 16px square. */
export function AgentBrandMenu({ name, size = 14 }: { name: string; size?: number }) {
  const t = useT()
  const { brandFor, setBrand } = useAgentIdentities()
  const brand = brandFor(name)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  const choose = (value: string) => {
    if (saving) return
    setSaving(true)
    setFailed(false)
    setBrand(name, value === AUTOMATIC ? null : (value as AgentBrandChoice))
      .then(() => setOpen(false))
      .catch((err) => {
        /* stay open so the note below shows and the choice can be retried */
        console.error(err)
        setFailed(true)
      })
      .finally(() => setSaving(false))
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setFailed(false)
      }}
    >
      <DropdownMenuTrigger asChild>
        {/* the row is click-to-frame; the trigger must not also open the frame */}
        <IconButton
          size="sm"
          aria-label={t('panels.activityAgentIcon')}
          onClick={(e) => e.stopPropagation()}
          className="size-4 rounded-row hover:bg-sub data-[state=open]:bg-sub"
        >
          <AgentIcon name={name} brand={brand} size={size} />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start" width="sm">
        <DropdownMenuRadioGroup value={brand ?? AUTOMATIC} onValueChange={choose}>
          <DropdownMenuRadioItem value={AUTOMATIC} onSelect={(e) => e.preventDefault()}>
            {t('panels.activityAgentIconAuto')}
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {BRAND_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} onSelect={(e) => e.preventDefault()}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuRadioItem value="doop" onSelect={(e) => e.preventDefault()}>
            {t('panels.activityAgentIconDoop')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {failed && (
          <DropdownMenuCaption className="pb-1.5 text-accent-ink" role="status">
            {t('panels.activityAgentIconFailed')}
          </DropdownMenuCaption>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
