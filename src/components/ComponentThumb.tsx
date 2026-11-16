import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../lib/store'

/** A short fingerprint of a string, to key a refetch on content rather than identity. */
function stamp(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0
  return (hash >>> 0).toString(36)
}

/** The open canvas's token values as a key part: a sheet carries them, so a
 *  token edit redraws a preview the way a new revision does. */
export function useTokenStamp(): string {
  const tokens = useStore((s) => s.canvas?.tokens)
  const themes = useStore((s) => s.canvas?.tokenThemes)
  return useMemo(() => stamp(JSON.stringify([tokens ?? [], themes ?? []])), [tokens, themes])
}

export interface PreviewSheet {
  html: string
  width: number
  height: number
}

/** A component's sheet in an inert iframe: no scripts, no clicks, fitted into a
 *  well of a fixed `height` and centred, so a list of them never moves while the
 *  sheets load (the well is there, empty, from the first frame). `sheetKey` names
 *  what is drawn, so a new revision asks again. */
export function ComponentThumb({
  title,
  sheetKey,
  load,
  height = 96,
}: {
  title: string
  sheetKey: string
  load: () => Promise<PreviewSheet>
  /** the well's height in px; the sheet is scaled down to fit inside it */
  height?: number
}) {
  const [sheet, setSheet] = useState<({ key: string } & PreviewSheet) | null>(null)
  /* the panel is resizable, so the sheet scales to the card it is in */
  const box = useRef<HTMLDivElement>(null)
  const [boxWidth, setBoxWidth] = useState(0)
  const loader = useRef(load)
  useEffect(() => {
    loader.current = load
  })
  useEffect(() => {
    if (!box.current) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBoxWidth(entry.contentRect.width)
    })
    observer.observe(box.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    let live = true
    loader
      .current()
      .then((next) => {
        if (live) setSheet({ key: sheetKey, ...next })
      })
      .catch(console.error)
    return () => {
      live = false
    }
  }, [sheetKey])
  const ready = sheet?.key === sheetKey && boxWidth > 0
  /* contain: the whole sheet shows, never wider than the well nor taller */
  const scale = ready ? Math.min(boxWidth / sheet.width, height / sheet.height) : 1
  return (
    <div
      ref={box}
      className="relative w-full overflow-hidden rounded-row bg-paper-deep shadow-ring"
      style={{ height }}
      data-component-thumb={ready ? 'ready' : 'loading'}
    >
      {ready && (
        <iframe
          title={title}
          sandbox=""
          srcDoc={sheet.html}
          tabIndex={-1}
          className="pointer-events-none absolute top-1/2 left-1/2 origin-center border-0 bg-surface"
          style={{
            width: sheet.width,
            height: sheet.height,
            transform: `translate(-50%, -50%) scale(${scale})`,
          }}
        />
      )}
    </div>
  )
}
