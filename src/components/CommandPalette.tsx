import { useMemo, useState } from 'react'
import { useT } from '../lib/i18n'
import { chordHint, firstChord } from '../lib/actions/chords'
import { ACTIONS, MENUS, isEnabled, runAction, type CanvasAction } from '../lib/actions/registry'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from './ui/command'
import { CheckIcon, SparkIcon } from './ui/icons'
import { Modal } from './ui/modal'

/**
 * ⌘K: every canvas command that can run right now, searchable by name and
 * grouped by the menu it lives in, each with its chord. Text that names no
 * command can go to the agent instead, as a prompt.
 */
export function CommandPalette({ onClose, onAsk }: { onClose: () => void; onAsk: ((prompt: string) => void) | null }) {
  const t = useT()
  const [query, setQuery] = useState('')
  /* what can run is read once, as the palette opens: the selection does not change under it */
  const [groups] = useState(() =>
    MENUS.map((menu) => ({
      menu,
      actions: ACTIONS.filter((a) => a.menu === menu.id && a.id !== 'palette' && isEnabled(a)),
    })).filter((g) => g.actions.length),
  )
  const ask = useMemo(() => (onAsk && query.trim() ? query.trim() : null), [onAsk, query])

  function choose(action: CanvasAction) {
    onClose()
    /* after the modal lets go of focus, so a command that opens a field keeps it */
    window.setTimeout(() => runAction(action), 0)
  }

  return (
    <Modal size="lg" onClose={onClose} className="p-0 sm:p-0" aria-label={t('actions.palette')}>
      <Command loop>
        <CommandInput
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder={t('actions.palettePlaceholder')}
          aria-label={t('actions.palette')}
        />
        <CommandList>
          <CommandEmpty>{t('actions.paletteEmpty')}</CommandEmpty>
          {groups.map(({ menu, actions }) => (
            <CommandGroup key={menu.id} heading={t(menu.label)}>
              {actions.map((action) => {
                const chord = firstChord(action.keys)
                const on = action.checked?.()
                return (
                  <CommandItem
                    key={action.id}
                    value={`${t(action.label)} ${t(menu.label)} ${action.id}`}
                    onSelect={() => choose(action)}
                  >
                    <span className="flex size-3.5 flex-none items-center text-ink">
                      {on && <CheckIcon width={14} height={14} aria-hidden />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{t(action.label)}</span>
                    {chord && <CommandShortcut>{chordHint(chord)}</CommandShortcut>}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          ))}
          {ask && onAsk && (
            <CommandGroup heading={t('actions.askAgent')} forceMount>
              <CommandItem
                forceMount
                value={`ask ${ask}`}
                onSelect={() => {
                  onClose()
                  onAsk(ask)
                }}
              >
                <SparkIcon width={14} height={14} aria-hidden className="flex-none text-brand" />
                <span className="min-w-0 flex-1 truncate">{t('actions.paletteAsk', { query: ask })}</span>
              </CommandItem>
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </Modal>
  )
}
