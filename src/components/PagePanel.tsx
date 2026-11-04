import type { CSSProperties } from 'react'
import { canvasPages } from '../../shared/pages'
import { pageBackground } from '../../shared/pageBackground'
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
  const t = useT()
  const canvas = useStore((s) => s.canvas)
  const activePageId = useStore((s) => s.activePageId)
  const setOpen = useStore((s) => s.setPagePanelOpen)
  if (!canvas) return null
  const pages = canvasPages(canvas)
  const page = pages.find((p) => p.id === activePageId) ?? pages[0]!

  async function paint(color: string | null) {
    if (!canvas) return
    try {
      await setPageBackground(canvas, page.id, color)
    } catch {
      if (useStore.getState().canvas?.id === canvas.id)
        useStore.getState().pushNotice(t('inspector.pageBackgroundFailed'))
    }
  }

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
            onCommit={(color) => void paint(color)}
          />
        </div>
      </section>
    </Panel>
  )
}
