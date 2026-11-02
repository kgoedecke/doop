import { useMemo } from 'react'
import { previewDocument, type LibraryComponent } from '../../../shared/designSystem'
import { cn } from '@/lib/utils'

/**
 * A component rendered the way a frame renders it: its markup in a sandboxed
 * document carrying the global stylesheet and the component's own CSS/JS,
 * stamped by the same function the server stamps frames with. With `scale`
 * the document lays out at 1/scale of its box and is shrunk back into it, so
 * a thumbnail shows the component smaller instead of cropping it at full size.
 */
export function ComponentPreview({
  globalCss,
  component,
  markup,
  className,
  title,
  scale,
  decorative = false,
}: {
  globalCss: string
  component: Pick<LibraryComponent, 'slug' | 'css' | 'js'>
  markup: string
  className?: string
  title: string
  /** shrink factor (0-1] for a thumbnail; the parent must clip (`overflow-hidden`) */
  scale?: number
  /** a picture beside a label that already names it: out of the tab order and the accessibility tree */
  decorative?: boolean
}) {
  const doc = useMemo(() => previewDocument(globalCss, component, markup), [globalCss, component, markup])
  const scaled = scale
    ? { width: `${100 / scale}%`, height: `${100 / scale}%`, transform: `scale(${scale})`, transformOrigin: '0 0' }
    : undefined
  return (
    <iframe
      title={title}
      srcDoc={doc}
      sandbox="allow-scripts"
      loading="lazy"
      tabIndex={decorative ? -1 : undefined}
      aria-hidden={decorative || undefined}
      style={scaled}
      className={cn('block w-full border-0 bg-surface', className)}
    />
  )
}
