import { useEffect, useState } from 'react'
import { activeComponents, type ComponentDef } from '../../shared/components'
import type { WorkspaceSummary } from '../../shared/types'
import { api, errorMessage, type CanvasLibrary, type ComponentLibrary, type LibraryChangeEntry } from '../lib/api'
import { LIBRARY_COMPONENT_DRAG_TYPE, libraryDragData, placeComponent } from '../lib/components'
import { useT } from '../lib/i18n'
import { dismissUpsell, libraryAttention, upsellVisible } from '../lib/library'
import { rememberLibraryResume } from '../lib/libraryResume'
import { posthog } from '../lib/posthog'
import { useStore } from '../lib/store'
import { ComponentThumb } from './ComponentThumb'
import { UpdateEverywhereButton } from './LibraryUpdateEverywhere'
import { CreateWorkspaceModal, MoveCanvasModal, UpgradeModal } from './WorkspaceModals'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { IconButton } from './ui/icon-button'
import { BookOpenIcon, XIcon } from './ui/icons'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'
import { Pressable } from './ui/pressable'

/**
 * The workspace library in the Components panel: what the workspace has
 * published for this canvas to use, the updates waiting to be pulled, the
 * canvas's own publish step, and, on a canvas that cannot have a library, the
 * card that says how to get one. Spec: .context/specs/workspace-component-library.md.
 */

function notice(text: string) {
  useStore.getState().pushNotice(text)
}

/* ---- using ---- */

function LibraryCard({
  canvasId,
  library,
  entry,
}: {
  canvasId: string
  library: ComponentLibrary
  entry: ComponentLibrary['components'][number]
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const add = async () => {
    if (busy) return
    setBusy(true)
    try {
      const def = await api.importComponent(canvasId, library.id, entry.id)
      /* another canvas was opened while this one took the component up: it is on the
         canvas that asked, and nothing is placed on the one now in view */
      if (useStore.getState().canvas?.id !== canvasId) return
      /* the room's message may not have landed yet, and placing reads the store */
      useStore.getState().setComponentLocal(def.id, def)
      await placeComponent(def)
    } catch (error) {
      notice(errorMessage(error, t('components.importFailed')))
    } finally {
      setBusy(false)
    }
  }
  return (
    /* a click places it; the card is also picked up and dropped onto the canvas,
       and only that drop takes the component up, so a drag let go elsewhere
       imports nothing. The wrapper carries the drag, as the canvas's own cards
       do: a button is not draggable in every engine */
    <div
      draggable={!busy}
      data-library-drag={entry.name}
      onDragStart={(event) => {
        event.dataTransfer.setData(
          LIBRARY_COMPONENT_DRAG_TYPE,
          libraryDragData({ libraryCanvasId: library.id, componentId: entry.id }),
        )
        event.dataTransfer.effectAllowed = 'copy'
      }}
    >
      <Pressable
        className="flex w-full flex-col gap-1.5 text-left"
        disabled={busy}
        aria-label={t('components.libraryPlaceAria', { name: entry.name, library: library.name })}
        data-library-card={entry.name}
        onClick={() => void add()}
      >
        <ComponentThumb
          title={t('components.previewTitle', { name: entry.name })}
          sheetKey={`${library.id}:${entry.id}:${entry.rev ?? 0}`}
          load={() => api.libraryPreview(canvasId, library.id, entry.id)}
        />
        <span className="flex min-w-0 items-center gap-1.5 text-body text-ink">
          <BookOpenIcon size="rail" className="flex-none text-ink-faint" />
          <span className="truncate">{entry.name}</span>
        </span>
        {entry.description && <span className="line-clamp-2 text-caption text-ink-soft">{entry.description}</span>}
      </Pressable>
    </div>
  )
}

/** What waits on someone, said first and in the accent colour: changes this
 *  library has not published (nobody else has them yet), and published updates
 *  this canvas has not taken. The tab wears a dot for the same two things.
 *  A library with everything published also says which canvases are still on an
 *  older version, with the one action that updates them all. */
export function LibraryNotices({
  canvasId,
  canEdit,
  status,
  onPublish,
}: {
  canvasId: string
  canEdit: boolean
  status: CanvasLibrary | null
  onPublish: () => void
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const attention = libraryAttention(status)
  /* only once everything is published: until then the first thing to do is publish */
  /* sending a library's changes out belongs to whoever may publish it */
  const behind =
    status?.entitled && status.library && status.canPublish !== false && !attention.unpublished
      ? (status.behind ?? [])
      : []
  if (!status || !canEdit || (!attention.unpublished && !attention.updates && !behind.length)) return null
  const updates = status.updates
  const pullAll = async () => {
    setBusy(true)
    try {
      for (const update of updates) await api.syncComponent(canvasId, update.id)
      notice(t('components.libraryUpdated', { count: updates.length }))
    } catch (error) {
      notice(errorMessage(error, t('components.libraryUpdateFailed')))
    } finally {
      setBusy(false)
    }
  }
  const instances = updates.reduce((total, update) => total + update.instances, 0)
  return (
    <>
      {attention.unpublished > 0 && (
        <div className="flex flex-col gap-1.5 rounded-card bg-brand/10 px-3 py-2.5" data-library-unpublished>
          <span className="text-body font-medium text-ink">
            {t('components.libraryPending', { count: attention.unpublished })}
          </span>
          <span className="text-caption text-ink-soft">{t('components.libraryPendingBody')}</span>
          <Button size="sm" variant="brand" className="mt-0.5" onClick={onPublish} data-library-publish>
            {t('components.libraryPublishChanges')}
          </Button>
        </div>
      )}
      {attention.updates > 0 && (
        <div className="flex flex-col gap-1.5 rounded-card bg-brand/10 px-3 py-2.5" data-library-updates>
          <span className="text-body font-medium text-ink">
            {t('components.libraryUpdates', { count: updates.length })}
          </span>
          <span className="text-caption text-ink-soft">
            {updates.map((update) => update.name).join(', ')}
            {instances ? ` · ${t('components.libraryUpdateReach', { count: instances })}` : ''}
          </span>
          <Button size="sm" variant="brand" className="mt-0.5" disabled={busy} onClick={() => void pullAll()}>
            {busy ? t('components.libraryUpdating') : t('components.libraryUpdateAll')}
          </Button>
        </div>
      )}
      {behind.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-card bg-brand/10 px-3 py-2.5" data-library-behind>
          <span className="text-body font-medium text-ink">
            {t('components.libraryBehind', { count: behind.length })}
          </span>
          <span className="text-caption text-ink-soft">{behind.map((canvas) => canvas.name).join(', ')}</span>
          <UpdateEverywhereButton canvasId={canvasId} count={behind.length} variant="brand" className="mt-0.5" />
        </div>
      )}
    </>
  )
}

/* ---- publishing ---- */

export function PublishLibraryDialog({
  canvasId,
  status,
  only,
  onClose,
  onDone,
}: {
  canvasId: string
  status: CanvasLibrary
  /** opened from one component's menu: start with just that one ticked */
  only?: string
  onClose: () => void
  onDone: () => void
}) {
  const t = useT()
  const pending = status.changes.filter((entry) => entry.change === 'new' || entry.change === 'changed')
  const removed = status.changes.filter((entry) => entry.change === 'removed')
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(pending.filter((entry) => !only || entry.id === only).map((entry) => entry.id)),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toggle = (id: string, on: boolean) =>
    setPicked((before) => {
      const next = new Set(before)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  const label = (entry: LibraryChangeEntry) =>
    entry.change === 'new'
      ? t('components.libraryChangeNew')
      : entry.change === 'changed'
        ? t('components.libraryChangeChanged')
        : t('components.libraryChangePublished')

  const publish = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.publishLibrary(canvasId, [...picked])
      notice(t('components.libraryPublished', { count: result.published.length }))
      onDone()
    } catch (caught) {
      setError(errorMessage(caught, t('components.libraryPublishFailed')))
      setBusy(false)
    }
  }
  const stop = async () => {
    setBusy(true)
    try {
      await api.unpublishLibrary(canvasId)
      notice(t('components.libraryStopped'))
      onDone()
    } catch (caught) {
      setError(errorMessage(caught, t('components.libraryPublishFailed')))
      setBusy(false)
    }
  }

  return (
    <Modal size="sm" onClose={onClose}>
      <>
        <ModalTitle>{t('components.libraryPublishTitle')}</ModalTitle>
        <ModalLede>{t('components.libraryPublishLede')}</ModalLede>
        <ul className="mt-4 flex max-h-72 flex-col gap-2 overflow-y-auto" data-library-changes>
          {status.changes
            .filter((entry) => entry.change !== 'removed')
            .map((entry) => (
              <li key={entry.id}>
                <label className="flex items-center gap-2.5 text-copy text-ink">
                  <Checkbox
                    checked={entry.change === 'unchanged' || picked.has(entry.id)}
                    disabled={busy || entry.change === 'unchanged'}
                    onChange={(event) => toggle(entry.id, event.target.checked)}
                  />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <Badge tone={entry.change === 'unchanged' ? 'outline' : 'brand'}>{label(entry)}</Badge>
                </label>
              </li>
            ))}
        </ul>
        {removed.length > 0 && (
          <p className="mt-3 text-label text-ink-soft">
            {t('components.libraryRemovedNote', { names: removed.map((entry) => entry.name).join(', ') })}
          </p>
        )}
        {error && <p className="mt-2 text-label text-accent-ink">{error}</p>}
        <ModalActions>
          {status.library && (
            <Button className="mr-auto" size="inline" variant="link" disabled={busy} onClick={() => void stop()}>
              {t('components.libraryStop')}
            </Button>
          )}
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={busy || (picked.size === 0 && removed.length === 0)}
            onClick={() => void publish()}
          >
            {busy ? t('components.libraryPublishing') : t('components.libraryPublish')}
          </Button>
        </ModalActions>
      </>
    </Modal>
  )
}

/* ---- getting one ---- */

type Wall = { workspaceId?: string }

/** From "this canvas cannot have a library" to one that can: the workspace's
 *  plan when that is what is missing, else a workspace to put the canvas in
 *  (made here if the person has none), which leads to its plan when it needs one. */
export function LibraryUpgradeFlow({
  canvas,
  wall,
  reason,
  only,
  onClose,
  onDone,
}: {
  canvas: { id: string; name: string }
  wall: Wall
  reason: string
  /** the one component they were publishing, to pick up again after checkout */
  only?: string
  onClose: () => void
  /** the canvas is in a workspace that may have a library now */
  onDone: () => void
}) {
  const t = useT()
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null)
  const [upgrade, setUpgrade] = useState<string | null>(wall.workspaceId ?? null)

  useEffect(() => {
    if (wall.workspaceId) return
    let live = true
    api.listWorkspaces().then(
      (response) => live && setWorkspaces(response.workspaces),
      () => live && setWorkspaces([]),
    )
    return () => {
      live = false
    }
  }, [wall.workspaceId])

  const moveInto = async (workspace: WorkspaceSummary) => {
    try {
      await api.moveCanvas(canvas.id, workspace.id)
      notice(t('components.libraryMoved', { name: workspace.name }))
      onDone()
    } catch (error) {
      notice(errorMessage(error, t('home.moveFailed')))
      onClose()
    }
  }

  if (upgrade)
    return (
      <UpgradeModal
        workspaceId={upgrade}
        reason={reason}
        onClose={onClose}
        /* checkout leaves the page: note the canvas, so the flow resumes on the way back */
        onCheckout={() =>
          rememberLibraryResume({ canvasId: canvas.id, workspaceId: upgrade, ...(only ? { componentId: only } : {}) })
        }
      />
    )
  if (!workspaces) return null
  if (workspaces.length === 0)
    return (
      <CreateWorkspaceModal
        onClose={onClose}
        onCreated={(workspace) => {
          setWorkspaces([workspace])
          /* a workspace that cannot grow yet goes to the plan picker first; the
             canvas moves in once it can, from this same card */
          if (workspace.active) void moveInto(workspace)
          else setUpgrade(workspace.id)
        }}
      />
    )
  return (
    <MoveCanvasModal
      canvas={canvas}
      workspaces={workspaces}
      /* this flow exists to get the canvas into a workspace: start on one, a live plan first */
      suggested={(workspaces.find((workspace) => workspace.active) ?? workspaces[0])?.id}
      onClose={onClose}
      onMoved={() => onDone()}
      onPaywall={(workspaceId) => setUpgrade(workspaceId)}
    />
  )
}

function UpsellCard({
  planRequired,
  billing,
  onStart,
  onDismiss,
}: {
  planRequired: boolean
  billing: boolean
  onStart: () => void
  onDismiss: () => void
}) {
  const t = useT()
  useEffect(() => {
    posthog.capture('library_upsell_shown', { plan_required: planRequired })
  }, [planRequired])
  return (
    <aside className="relative flex flex-col gap-1 rounded-card bg-sub px-3 py-3" data-library-upsell>
      <IconButton
        size="sm"
        className="absolute top-1.5 right-1.5"
        aria-label={t('components.libraryUpsellDismiss')}
        onClick={onDismiss}
      >
        <XIcon size="rail" aria-hidden />
      </IconButton>
      <BookOpenIcon size="rail" className="text-ink-soft" aria-hidden />
      <span className="mt-1 pr-6 text-body font-medium text-ink">{t('components.libraryUpsellTitle')}</span>
      <span className="text-caption text-ink-soft">
        {planRequired
          ? t('components.libraryUpsellPlan')
          : billing
            ? t('components.libraryUpsellWorkspace')
            : t('components.libraryUpsellSelfHosted')}
      </span>
      <Button size="inline" variant="link" className="self-start" onClick={onStart}>
        {planRequired
          ? t('components.libraryUpsellUpgrade')
          : billing
            ? t('components.libraryUpsellStart')
            : t('components.libraryUpsellMove')}
      </Button>
    </aside>
  )
}

/* ---- the section ---- */

export function LibrarySection({
  canvasId,
  canEdit,
  query,
  status,
  libraries,
  onPublish,
  onWall,
}: {
  canvasId: string
  canEdit: boolean
  query: string
  status: CanvasLibrary | null
  libraries: ComponentLibrary[]
  /** open the publish dialog */
  onPublish: () => void
  /** start the way to a library: a workspace, or its plan */
  onWall: (wall: Wall) => void
}) {
  const t = useT()
  const components = useStore((s) => s.canvas?.components)
  const count = activeComponents(components).length
  /* read each render, not once: the card returns when the canvas reaches its
     fifth component, which can happen with the panel open. Dismissing writes the
     browser's memory, so this state only asks for the render that reads it back */
  const [, setDismissals] = useState(0)
  const upsell = upsellVisible(count)
  if (!status || !canEdit) return null

  if (!status.entitled) {
    if (!upsell) return null
    const planRequired = status.blocked === 'plan_required'
    return (
      <UpsellCard
        planRequired={planRequired}
        billing={status.billing}
        onStart={() => {
          posthog.capture('library_upsell_clicked', { plan_required: planRequired })
          onWall(planRequired ? { workspaceId: status.workspaceId } : {})
        }}
        onDismiss={() => {
          posthog.capture('library_upsell_dismissed', { plan_required: planRequired })
          dismissUpsell(count)
          setDismissals((times) => times + 1)
        }}
      />
    )
  }

  const wanted = query.trim().toLowerCase()
  const linked = new Set(
    (components ?? []).flatMap((def: ComponentDef) =>
      def.source?.library ? [`${def.source.canvasId}:${def.id}`] : [],
    ),
  )
  const offered = libraries
    .map((library) => ({
      library,
      entries: library.components.filter(
        (entry) =>
          !linked.has(`${library.id}:${entry.id}`) &&
          (!wanted || `${entry.name} ${entry.description ?? ''}`.toLowerCase().includes(wanted)),
      ),
    }))
    .filter((group) => group.entries.length)
  const pending = status.changes.filter((entry) => entry.change !== 'unchanged').length
  const publishable = status.changes.some((entry) => entry.change !== 'removed')

  return (
    <>
      {offered.map(({ library, entries }) => (
        <section key={library.id} className="flex flex-col gap-2" data-library={library.name}>
          <h3 className="mt-1 border-t border-line-soft pt-2.5 text-caption text-ink-soft">
            {t('components.libraryHeading', { name: library.name })}
          </h3>
          {entries.map((entry) => (
            <LibraryCard key={entry.id} canvasId={canvasId} library={library} entry={entry} />
          ))}
        </section>
      ))}
      {/* unpublished changes are said at the top of the panel (LibraryNotices); this is the quiet state */}
      {(publishable || status.library) && pending === 0 && status.library && (
        <p className="mt-1 border-t border-line-soft pt-2.5 text-caption text-ink-soft">
          {t('components.libraryUpToDate')}
        </p>
      )}
      {publishable && !status.library && status.canPublish && (
        <div className="mt-1 flex flex-col gap-1 border-t border-line-soft pt-2.5">
          <Button size="sm" onClick={onPublish} data-library-publish>
            {t('components.libraryPublishFirst')}
          </Button>
          <span className="text-caption text-ink-soft">{t('components.libraryPublishHint')}</span>
        </div>
      )}
    </>
  )
}
