import { t } from './i18n'
import { openingPageId, pageLink, pageSearch } from './pageLink'
import { useStore } from './store'

/** Keep the address bar and the open page of canvas `canvasId` in step, for
 *  as long as the canvas page is mounted: a page switch rewrites the query in
 *  place (no history entry, like the Workspace page's `?pane=`), and a move
 *  through the browser's history opens the page that entry names. Returns the
 *  cleanup. */
export function followPageInUrl(canvasId: string): () => void {
  /* the canvas page's own address: once the route has moved on (the page is
     about to unmount), the URL is another screen's and is left alone */
  const path = location.pathname
  const onCanvas = () => location.pathname === path

  function write() {
    const { canvas, activePageId } = useStore.getState()
    if (!canvas || canvas.id !== canvasId || !activePageId || !onCanvas()) return
    const search = pageSearch(canvas, location.search, activePageId)
    if (search === location.search) return
    history.replaceState(history.state, '', `${location.pathname}${search}${location.hash}`)
  }

  function onPop() {
    const { canvas, setActivePage } = useStore.getState()
    if (!canvas || canvas.id !== canvasId || !onCanvas()) return
    setActivePage(openingPageId(canvas, location.search))
  }

  write()
  const unsubscribe = useStore.subscribe((s, p) => {
    if (s.canvas !== p.canvas || s.activePageId !== p.activePageId) write()
  })
  window.addEventListener('popstate', onPop)
  return () => {
    unsubscribe()
    window.removeEventListener('popstate', onPop)
  }
}

export async function copyPageLink(canvasId: string, pageId: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(pageLink(canvasId, pageId))
    useStore.getState().pushNotice(t('panels.pagesLinkCopied'))
  } catch {
    useStore.getState().pushNotice(t('panels.pagesLinkCopyFailed'))
  }
}
