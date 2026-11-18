import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { openCanvasTab } from '../lib/desktop'
import { useT } from '../lib/i18n'
import { navigate } from '../lib/navigate'
import { timeAgo } from '../lib/time'
import { UpdateEverywhereButton } from './LibraryUpdateEverywhere'
import { Button } from './ui/button'
import { CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from './ui/card'
import { EmptyState } from './ui/empty-state'
import { Note } from './ui/note'

type WorkspaceLibrary = Awaited<ReturnType<typeof api.workspaceLibraries>>[number]

/** The Workspace page's Libraries pane: the canvases that publish components to
 *  this workspace, how much each offers and how widely it is used. Publishing
 *  itself happens on the canvas, in its Components tab. */
export function WorkspaceLibraries({
  workspaceId,
  onToast,
}: {
  workspaceId: string
  /** the page's toast: what an update-everywhere did, or why it did nothing */
  onToast: (text: string) => void
}) {
  const t = useT()
  const [loaded, setLoaded] = useState<{ workspaceId: string; libraries: WorkspaceLibrary[] | 'failed' } | null>(null)
  /* an update everywhere changes who is behind: read the list again */
  const [reloads, setReloads] = useState(0)

  useEffect(() => {
    let live = true
    api.workspaceLibraries(workspaceId).then(
      (libraries) => live && setLoaded({ workspaceId, libraries }),
      () => live && setLoaded({ workspaceId, libraries: 'failed' }),
    )
    return () => {
      live = false
    }
  }, [workspaceId, reloads])

  /* another workspace's answer is not this one's */
  const libraries = loaded?.workspaceId === workspaceId ? loaded.libraries : null
  const open = (id: string, name: string) => {
    if (!openCanvasTab(id, name)) navigate(`/c/${id}`)
  }

  return (
    <SettingsCard data-slot="workspace-libraries">
      <CardHeader>
        <CardTitle>{t('workspace.librariesTitle')}</CardTitle>
        <CardDescription>{t('workspace.librariesDescription')}</CardDescription>
      </CardHeader>
      {libraries === null ? (
        <CardRow label={t('workspace.librariesLoading')} />
      ) : libraries === 'failed' ? (
        <div className="px-4 py-5 sm:px-[22px]">
          <Note tone="error">{t('workspace.librariesFailed')}</Note>
        </div>
      ) : libraries.length === 0 ? (
        <div className="px-4 py-5 sm:px-[22px]">
          <EmptyState
            variant="dashed"
            className="border"
            title={t('workspace.librariesEmptyTitle')}
            description={t('workspace.librariesEmpty')}
          />
        </div>
      ) : (
        libraries.map((library) => (
          <CardRow
            key={library.id}
            label={library.name}
            action={
              <span className="flex items-center gap-2">
                {!!library.behind && (
                  <UpdateEverywhereButton
                    canvasId={library.id}
                    count={library.behind}
                    onDone={() => setReloads((count) => count + 1)}
                    onNotice={onToast}
                  />
                )}
                <Button size="sm" onClick={() => open(library.id, library.name)} data-library-open>
                  {t('workspace.librariesOpen')}
                </Button>
              </span>
            }
          >
            <Note>
              {[
                t('workspace.librariesComponents', { count: library.components }),
                t('workspace.librariesUsedBy', { count: library.usedBy }),
                ...(library.behind ? [t('workspace.librariesBehind', { count: library.behind })] : []),
                t('workspace.librariesPublished', { when: timeAgo(library.publishedAt) }),
              ].join(' · ')}
            </Note>
          </CardRow>
        ))
      )}
    </SettingsCard>
  )
}
