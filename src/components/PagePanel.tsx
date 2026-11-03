import type { CSSProperties } from 'react'
import { canvasPages } from '../../shared/pages'
import { pageBackground } from '../../shared/pageBackground'
import type { Canvas, CanvasPageInfo } from '../../shared/types'
import { useStore } from '../lib/store'
import { setPageBackground } from '../lib/pageEdits'
import { cn } from '../lib/utils'
import { Panel, PanelClose, PanelHeader, type PanelSurface } from './ui/panel'
import { ColorField } from './ui/property-field'
import { PageIcon } from './ui/icons'
import { useT } from '@/lib/i18n'

/** The page's own settings, in the properties slot while nothing is
 *  selected, as Figma's Design panel shows "Page" then: today the canvas
 *  colour behind the page's frames. */
export function PagePanel({
  surface = 'floating',
  className,
  style,
}: {
  surface?: PanelSurface
  className?: string
  style?: CSSProperties
}) {
  const canvas = useStore((s) => s.canvas)
  const activePageId = useStore((s) => s.activePageId)
  const setOpen = useStore((s) => s.setPagePanelOpen)
  const paintPage = usePaintPage()
  if (!canvas) return null
  const pages = canvasPages(canvas)
  const page = pages.find((p) => p.id === activePageId) ?? pages[0]!

  return (
    <Panel
      surface={surface}
      className={cn(
        surface === 'floating' && 'top-2.5 bottom-3.5 w-[244px] transition-[right] duration-150',
        surface === 'docked' && 'w-[244px] border-l',
        className,
      )}
      style={style}
    >
      <PanelHeader className="pl-2.5">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-label text-ink">
          <PageIcon size="rail" className="flex-none text-ink-faint" />
          <span className="truncate">{page.name}</span>
        </span>
        <PanelClose onClick={() => setOpen(false)} />
      </PanelHeader>
      <PageBackgroundField page={page} onCommit={(color) => void paintPage(canvas, page.id, color)} />
    </Panel>
  )
}

/** The "Background" section: a heading over a full-width swatch and hex
 *  field, as Figma lays its fills out. The Page panel shows it on desktop;
 *  the phone's Layers sheet shows it under the page list, since a phone has
 *  no rail to open the panel from. */
export function PageBackgroundField({
  page,
  onCommit,
}: {
  page: CanvasPageInfo
  onCommit: (color: string | null) => void
}) {
  const t = useT()
  return (
    <section className="border-b border-line-soft px-3 py-2">
      <h3 className="mb-1.5 flex h-5 items-center text-label font-normal text-ink-soft">
        {t('inspector.pageBackground')}
      </h3>
      {/* the field's keys stay out of the canvas shortcuts */}
      <div className="flex" onKeyDown={(e) => e.stopPropagation()}>
        <ColorField
          key={page.id}
          label={t('inspector.pageBackground')}
          value={pageBackground(page)}
          onCommit={onCommit}
        />
      </div>
    </section>
  )
}

/** Paint a page, telling the person when the save fails. */
export function usePaintPage() {
  const t = useT()
  return async (canvas: Canvas, pageId: string, color: string | null) => {
    try {
      await setPageBackground(canvas, pageId, color)
    } catch {
      if (useStore.getState().canvas?.id === canvas.id)
        useStore.getState().pushNotice(t('inspector.pageBackgroundFailed'))
    }
  }
}
