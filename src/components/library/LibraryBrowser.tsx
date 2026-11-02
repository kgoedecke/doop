import { useState, type ReactNode } from 'react'
import type { ComponentGroup, LibraryComponent, LibrarySnapshot } from '../../../shared/designSystem'
import { api, errorMessage, type ComponentDraft } from '../../lib/api'
import { groupLabel, useLibrary } from '../../lib/library'
import { useT } from '../../lib/i18n'
import { cn } from '@/lib/utils'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { Field } from '../ui/field'
import { Input } from '../ui/input'
import { Pressable } from '../ui/pressable'
import { SearchField } from '../ui/search-field'
import { Skeleton } from '../ui/skeleton'
import { Textarea } from '../ui/textarea'
import { ConfirmDialog } from '../ui/alert-dialog'
import { Modal, ModalActions, ModalSpacer, ModalTitle } from '../ui/modal'
import { CodeIcon, ComponentIcon, FolderPlusIcon, PlusIcon } from '../ui/icons'
import { ComponentEditor, type ComponentSeed } from './ComponentEditor'
import { ComponentPreview } from './ComponentPreview'
import { GlobalStylesEditor } from './GlobalStylesEditor'

const ALL = 'all'

type Editing =
  | { kind: 'component'; component?: LibraryComponent; seed?: ComponentSeed }
  | { kind: 'styles' }
  | { kind: 'group'; group?: ComponentGroup }

function matches(component: LibraryComponent, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return [component.name, component.slug, component.kind ?? '', component.description].some((field) =>
    field.toLowerCase().includes(q),
  )
}

/**
 * The whole component library of a canvas or a workspace: its groups down
 * the side (presets first, then custom ones), and the chosen group's
 * components as live previews, with an add tile for each preset kind the
 * library has not filled yet. `onInsert` adds an Insert action (the canvas).
 */
export function LibraryBrowser({
  canvasId,
  workspaceId,
  onInsert,
}: {
  canvasId?: string
  workspaceId?: string
  onInsert?: (component: LibraryComponent) => void
}) {
  const t = useT()
  const { snapshot, error, run } = useLibrary(canvasId, workspaceId)
  const [groupId, setGroupId] = useState(ALL)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Editing | null>(null)

  if (error) return <p className="text-body text-accent-ink">{error}</p>
  if (!snapshot) return <Skeleton shape="card" className="max-w-[1000px]" />

  const group = snapshot.groups.find((g) => g.id === groupId)
  const visible = snapshot.components.filter((c) => (groupId === ALL || c.groupId === groupId) && matches(c, query))
  const filledKinds = new Set(snapshot.components.filter((c) => c.groupId === groupId).map((c) => c.kind))
  const openKinds = group && !query ? group.kinds.filter((kind) => !filledKinds.has(kind)) : []
  const countIn = (id: string) => snapshot.components.filter((c) => c.groupId === id).length
  const groupNameOf = (id: string) => {
    const g = snapshot.groups.find((entry) => entry.id === id)
    return g ? groupLabel(g, t) : id
  }

  const saveComponent = (draft: ComponentDraft, id?: string) =>
    run((target) => api.saveComponent(target, draft, id)).then(() => undefined)

  return (
    <div className="grid gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
      <nav aria-label={t('library.groupsNav')} className="flex flex-col gap-0.5">
        <GroupRow active={groupId === ALL} count={snapshot.components.length} onClick={() => setGroupId(ALL)}>
          {t('library.allComponents')}
        </GroupRow>
        <GroupRow onClick={() => setEditing({ kind: 'styles' })}>
          <CodeIcon size="rail" /> {t('library.globalStylesheet')}
        </GroupRow>
        <span className="mt-3 mb-1 px-2.5 text-caption text-ink-faint">{t('library.groups')}</span>
        {snapshot.groups.map((g) => (
          <GroupRow key={g.id} active={groupId === g.id} count={countIn(g.id)} onClick={() => setGroupId(g.id)}>
            {groupLabel(g, t)}
          </GroupRow>
        ))}
        {snapshot.canEdit && (
          <Button variant="bare" size="sm" className="mt-1 justify-start" onClick={() => setEditing({ kind: 'group' })}>
            <FolderPlusIcon size="rail" /> {t('library.newGroup')}
          </Button>
        )}
      </nav>

      <section className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="min-w-0 flex-1">
            <h2 className="text-heading font-semibold text-ink">
              {group ? groupLabel(group, t) : t('library.allComponents')}
            </h2>
            <p className="text-body text-ink-soft">
              {group?.description ??
                (group?.preset
                  ? t('library.presetGroupHint')
                  : group
                    ? t('library.customGroupHint')
                    : t('library.allHint', { count: snapshot.components.length }))}
            </p>
          </div>
          <SearchField placeholder={t('library.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
          {group && !group.preset && snapshot.canEdit && (
            <Button size="sm" onClick={() => setEditing({ kind: 'group', group })}>
              {t('library.editGroup')}
            </Button>
          )}
          {snapshot.canEdit && (
            <Button
              variant="primary"
              size="bar"
              onClick={() => setEditing({ kind: 'component', seed: { groupId: group?.id ?? 'buttons' } })}
            >
              <PlusIcon /> {t('library.newComponent')}
            </Button>
          )}
        </div>

        {!snapshot.canEdit && <p className="mt-3 text-body text-ink-faint">{t('library.readOnlyNote')}</p>}

        <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {visible.map((component) => (
            <ComponentTile
              key={component.id}
              snapshot={snapshot}
              component={component}
              groupName={groupId === ALL ? groupNameOf(component.groupId) : undefined}
              onOpen={() => setEditing({ kind: 'component', component })}
              onInsert={onInsert}
            />
          ))}
          {snapshot.canEdit &&
            group &&
            openKinds.map((kind) => (
              <Card key={kind} tone="dashed" className="overflow-hidden">
                <Pressable
                  className="flex h-full min-h-[168px] flex-col items-center justify-center gap-1.5 p-4 text-center"
                  onClick={() => setEditing({ kind: 'component', seed: { groupId: group.id, kind } })}
                >
                  <PlusIcon className="text-ink-faint" />
                  <span className="text-body font-medium text-ink">{kind}</span>
                  <span className="text-caption text-ink-faint">{t('library.startFromReady')}</span>
                </Pressable>
              </Card>
            ))}
        </div>
        {visible.length === 0 && openKinds.length === 0 && (
          <div className="mt-6 flex flex-col items-center gap-2 py-10 text-center">
            <ComponentIcon size={28} className="text-ink-faint" />
            <p className="text-copy text-ink-soft">{query ? t('library.searchEmpty') : t('library.nothingHere')}</p>
          </div>
        )}
      </section>

      {editing?.kind === 'component' && (
        <ComponentEditor
          snapshot={snapshot}
          component={editing.component}
          seed={editing.seed}
          onSave={saveComponent}
          onDelete={(id) => run((target) => api.deleteComponent(target, id)).then(() => undefined)}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.kind === 'styles' && (
        <GlobalStylesEditor
          snapshot={snapshot}
          onSave={(styles) => run((target) => api.saveLibraryStyles(target, styles)).then(() => undefined)}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.kind === 'group' && (
        <GroupEditor
          group={editing.group}
          onSave={async (input) => {
            const editedGroup = editing.group
            const next = await run((target) =>
              editedGroup
                ? api.updateComponentGroup(target, editedGroup.id, input)
                : api.createComponentGroup(target, input),
            )
            if (!editedGroup) setGroupId(next.groups[next.groups.length - 1]?.id ?? ALL)
          }}
          onDelete={
            editing.group
              ? async () => {
                  const doomed = editing.group!.id
                  await run((target) => api.deleteComponentGroup(target, doomed))
                  setGroupId(ALL)
                }
              : undefined
          }
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function GroupRow({
  active = false,
  count,
  onClick,
  children,
}: {
  active?: boolean
  count?: number
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Pressable
      focus="ring"
      onClick={onClick}
      aria-current={active || undefined}
      className={cn(
        'flex h-8 items-center gap-2 rounded-row px-2.5 text-body text-ink-soft transition-colors hover:bg-paper-deep hover:text-ink',
        active && 'bg-paper-deep font-medium text-ink',
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{children}</span>
      {count !== undefined && count > 0 && <span className="font-mono text-caption text-ink-faint">{count}</span>}
    </Pressable>
  )
}

function ComponentTile({
  snapshot,
  component,
  groupName,
  onOpen,
  onInsert,
}: {
  snapshot: LibrarySnapshot
  component: LibraryComponent
  groupName?: string
  onOpen: () => void
  onInsert?: (component: LibraryComponent) => void
}) {
  const t = useT()
  return (
    <Card tone="raised" className="flex flex-col overflow-hidden">
      <Pressable onClick={onOpen} aria-label={t('library.openNamed', { name: component.name })} className="relative">
        {/* the preview is a picture here: clicks open the editor */}
        <ComponentPreview
          title={t('library.previewOf', { name: component.name })}
          globalCss={snapshot.styles.globalCss}
          component={component}
          markup={component.html}
          className="pointer-events-none h-[132px]"
        />
      </Pressable>
      <div className="flex items-start gap-2 border-t border-line-soft px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-medium text-ink">{component.name}</div>
          <div className="flex items-center gap-1.5 truncate text-caption text-ink-faint">
            <span className="font-mono">{component.slug}</span>
            {groupName && <span>· {groupName}</span>}
          </div>
        </div>
        {component.variants.length > 0 && <Badge>{t('library.looks', { count: component.variants.length + 1 })}</Badge>}
        {onInsert && (
          <Button size="sm" onClick={() => onInsert(component)}>
            {t('library.insert')}
          </Button>
        )}
      </div>
    </Card>
  )
}

function GroupEditor({
  group,
  onSave,
  onDelete,
  onClose,
}: {
  group?: ComponentGroup
  onSave: (input: { name: string; description: string }) => Promise<void>
  onDelete?: () => Promise<void>
  onClose: () => void
}) {
  const t = useT()
  const [name, setName] = useState(group?.name ?? '')
  const [description, setDescription] = useState(group?.description ?? '')
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const attempt = (work: () => Promise<void>) =>
    work()
      .then(onClose)
      .catch((caught: unknown) => setError(errorMessage(caught, t('library.somethingWrong'))))

  return (
    <Modal size="sm" onClose={onClose}>
      <ModalTitle>{group ? t('library.editGroup') : t('library.newGroup')}</ModalTitle>
      <div className="mt-4 flex flex-col gap-3">
        <Field label={t('library.name')} labelVariant="form">
          <Input
            autoFocus
            variant="well"
            value={name}
            placeholder={t('library.groupNamePlaceholder')}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label={t('library.description')} labelVariant="form">
          <Textarea
            variant="well"
            rows={3}
            value={description}
            placeholder={t('library.groupDescriptionPlaceholder')}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>
      {error && <p className="mt-3 text-body text-accent-ink">{error}</p>}
      <ModalActions>
        {onDelete && (
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            {t('library.delete')}
          </Button>
        )}
        <ModalSpacer />
        <Button variant="ghost" onClick={onClose}>
          {t('library.cancel')}
        </Button>
        <Button
          variant="primary"
          disabled={!name.trim()}
          onClick={() => void attempt(() => onSave({ name: name.trim(), description: description.trim() }))}
        >
          {group ? t('library.save') : t('library.addGroup')}
        </Button>
      </ModalActions>
      {onDelete && (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          destructive
          title={t('library.deleteGroupTitle', { name: group?.name ?? '' })}
          description={t('library.deleteGroupBody')}
          confirmLabel={t('library.deleteGroupConfirm')}
          onConfirm={() => void attempt(onDelete)}
        />
      )}
    </Modal>
  )
}
