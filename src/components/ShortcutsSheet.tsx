import { useState } from 'react'
import { useT } from '../lib/i18n'
import { TOOLS } from '../lib/tools'
import { boundOn, chordHint } from '../lib/actions/chords'
import { ACTIONS, MENUS } from '../lib/actions/registry'
import { Kbd } from './ui/kbd'
import { Modal, ModalTitle } from './ui/modal'
import { SearchField } from './ui/search-field'

/**
 * ⌃⇧?: every chord the canvas knows, the tools first and then each menu's
 * commands, filtered as you type. Read from the registry, so it can never
 * list a shortcut that does not work.
 */
export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const tools = TOOLS.map((tool) => ({ id: tool.id, label: t(tool.label), hints: [tool.key] }))
  const groups = [
    { id: 'tools', label: t('stage.canvasTools'), rows: tools },
    ...MENUS.map((menu) => ({
      id: menu.id,
      label: t(menu.label),
      rows: ACTIONS.filter((a) => a.menu === menu.id && a.keys?.some((k) => boundOn(k))).map((a) => ({
        id: a.id,
        label: t(a.label),
        hints: a.keys!.filter((k) => boundOn(k)).map((k) => chordHint(k)),
      })),
    })),
  ]
    .map((g) => ({ ...g, rows: g.rows.filter((r) => !q || r.label.toLowerCase().includes(q)) }))
    .filter((g) => g.rows.length)

  return (
    <Modal size="lg" onClose={onClose} aria-label={t('actions.keyboardShortcuts')}>
      <ModalTitle>{t('actions.keyboardShortcuts')}</ModalTitle>
      <SearchField
        autoFocus
        className="mt-3"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('actions.shortcutsSearch')}
        aria-label={t('actions.shortcutsSearch')}
      />
      <div className="mt-3 max-h-[60vh] overflow-y-auto pr-1">
        {groups.length === 0 && (
          <p className="py-6 text-center text-body text-ink-faint">
            {t('actions.shortcutsEmpty', { query: query.trim() })}
          </p>
        )}
        <div className="columns-1 gap-6 sm:columns-2">
          {groups.map((group) => (
            <section key={group.id} className="mb-4 break-inside-avoid">
              <h3 className="mb-1 text-caption text-ink-faint">{group.label}</h3>
              <ul>
                {group.rows.map((row) => (
                  <li key={row.id} className="flex items-center gap-2 py-1 text-body text-ink">
                    <span className="min-w-0 flex-1 truncate">{row.label}</span>
                    {row.hints.map((hint) => (
                      <Kbd key={hint} className="px-1.5">
                        {hint}
                      </Kbd>
                    ))}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </Modal>
  )
}
