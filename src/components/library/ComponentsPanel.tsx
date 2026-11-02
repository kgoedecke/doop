import { useState } from 'react'
import { cssTokens, type LibraryComponent } from '../../../shared/designSystem'
import { errorMessage } from '../../lib/api'
import { groupLabel, insertComponent, useLibrary } from '../../lib/library'
import { isCanvasElement } from '../../lib/drawing'
import { canEditOpenCanvas, useStore } from '../../lib/store'
import { t as translate, useT } from '../../lib/i18n'
import { Button } from '../ui/button'
import { IconButton } from '../ui/icon-button'
import { Pressable } from '../ui/pressable'
import { PanelBody } from '../ui/panel'
import { SearchField } from '../ui/search-field'
import { Modal, ModalLede, ModalTitle } from '../ui/modal'
import { ComponentIcon, PlusIcon } from '../ui/icons'
import { ComponentPreview } from './ComponentPreview'
import { LibraryBrowser } from './LibraryBrowser'

function insert(canvasId: string, component: LibraryComponent, globalCss: string) {
  insertComponent(canvasId, component, globalCss).catch((caught: unknown) =>
    useStore.getState().pushNotice(errorMessage(caught, translate('library.addFailed', { name: component.name }))),
  )
}

/**
 * The Components tab of the canvas side panel: the library this canvas draws
 * from, grouped and searchable. A row inserts its component into the
 * selected frame (or a new one); the full library opens in a modal.
 */
export function ComponentsPanel({ canvasId }: { canvasId: string }) {
  const t = useT()
  const { snapshot, error } = useLibrary(canvasId)
  const canEdit = useStore(canEditOpenCanvas)
  const selectedFrame = useStore((s) => {
    const frame = s.canvas?.frames.find((f) => f.id === s.selectedId)
    return frame && !isCanvasElement(frame.html) ? frame.name : undefined
  })
  const [query, setQuery] = useState('')
  const [browsing, setBrowsing] = useState(false)

  if (error) return <p className="px-4 py-6 text-body text-accent-ink">{error}</p>
  if (!snapshot) return null

  const q = query.trim().toLowerCase()
  const shown = snapshot.components.filter(
    (c) => !q || c.name.toLowerCase().includes(q) || c.slug.includes(q) || (c.kind ?? '').toLowerCase().includes(q),
  )
  const groups = snapshot.groups
    .map((group) => ({ group, components: shown.filter((c) => c.groupId === group.id) }))
    .filter((entry) => entry.components.length > 0)
  const scopeNote = snapshot.scope.startsWith('workspace:')
    ? t('library.scopeWorkspace')
    : snapshot.scope.startsWith('user:')
      ? t('library.scopeUser')
      : t('library.scopeCanvas')

  return (
    <PanelBody className="flex flex-col">
      <div className="flex flex-col gap-2 border-b border-line-soft px-3 py-3">
        <SearchField placeholder={t('library.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-caption text-ink-faint">
            {t('library.summary', {
              components: snapshot.components.length,
              tokens: cssTokens(snapshot.styles.globalCss).length,
            })}
          </span>
          <Button size="sm" onClick={() => setBrowsing(true)}>
            <ComponentIcon size="rail" /> {t('library.openLibrary')}
          </Button>
        </div>
        {canEdit && snapshot.components.length > 0 && (
          <span className="text-caption text-ink-faint">
            {selectedFrame ? t('library.insertsInto', { frame: selectedFrame }) : t('library.insertsNew')}
          </span>
        )}
      </div>

      {snapshot.components.length === 0 ? (
        <div className="flex flex-col items-start gap-2.5 px-4 py-5">
          <p className="text-body font-medium text-ink">{t('library.emptyTitle')}</p>
          <p className="text-body text-ink-soft">{t('library.emptyBody')}</p>
          <Button variant="primary" size="sm" onClick={() => setBrowsing(true)}>
            {t('library.emptyAction')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col pb-3">
          {groups.map(({ group, components }) => (
            <section key={group.id}>
              <h3 className="px-4 pt-3 pb-1 text-caption text-ink-faint">{groupLabel(group, t)}</h3>
              {components.map((component) => (
                <div key={component.id} className="group/row flex items-center gap-1 px-2">
                  <Pressable
                    focus="ring"
                    disabled={!canEdit}
                    title={component.description || undefined}
                    onClick={() => insert(canvasId, component, snapshot.styles.globalCss)}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-row px-2 py-1.5 hover:bg-paper-deep disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    {/* the thumbnail is a picture: clicks land on the row */}
                    <span className="pointer-events-none h-16 w-24 flex-none overflow-hidden rounded-row bg-surface shadow-ring">
                      <ComponentPreview
                        title={t('library.previewOf', { name: component.name })}
                        globalCss={snapshot.styles.globalCss}
                        component={component}
                        markup={component.html}
                        scale={0.5}
                        decorative
                      />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-body text-ink">{component.name}</span>
                      <span className="truncate font-mono text-caption text-ink-faint">{component.slug}</span>
                    </span>
                  </Pressable>
                  {canEdit && (
                    <IconButton
                      size="sm"
                      aria-label={t('library.insertNamed', { name: component.name })}
                      className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
                      onClick={() => insert(canvasId, component, snapshot.styles.globalCss)}
                    >
                      <PlusIcon size="rail" />
                    </IconButton>
                  )}
                </div>
              ))}
            </section>
          ))}
          {groups.length === 0 && <p className="px-4 py-6 text-body text-ink-faint">{t('library.noMatch')}</p>}
        </div>
      )}

      {browsing && (
        <Modal onClose={() => setBrowsing(false)} className="max-w-[min(1240px,calc(100vw-24px))]">
          <ModalTitle>{t('library.modalTitle')}</ModalTitle>
          <ModalLede>
            {scopeNote} {t('library.agentsRead')}
          </ModalLede>
          <div className="mt-4">
            <LibraryBrowser
              canvasId={canvasId}
              onInsert={
                canEdit
                  ? (component) => {
                      insert(canvasId, component, snapshot.styles.globalCss)
                      setBrowsing(false)
                    }
                  : undefined
              }
            />
          </div>
        </Modal>
      )}
    </PanelBody>
  )
}
