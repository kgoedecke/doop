import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * A frame's rendered preview (`/i/<id>.jpg?preview`) filling whatever box it
 * is given, with the two states a box must be able to show instead: nothing
 * to preview (`empty`), and a render that failed to load. A failed render
 * must look different from an empty canvas — silence here once made preview
 * outages undiagnosable — and the failure is remembered per frame id, so a
 * new preview frame retries rather than inheriting the old one's failure.
 */
export function FramePreview({
  frameId,
  empty = 'empty canvas',
  className,
}: {
  frameId?: string | null
  /** what an empty box says; `null` for a plain blank (a tiny thumb) */
  empty?: ReactNode
  /** the fallback text's size and colour; the image itself always fills the box */
  className?: string
}) {
  const [failedId, setFailedId] = useState<string | null>(null)
  const fallback = (text: ReactNode) =>
    text === null ? null : (
      <span className={cn('grid h-full w-full place-items-center text-label text-ink-faint', className)}>{text}</span>
    )
  if (!frameId) return fallback(empty)
  if (failedId === frameId) return fallback('preview unavailable')
  return (
    <img
      src={`/i/${frameId}.jpg?preview`}
      alt=""
      loading="lazy"
      className="h-full w-full object-cover object-top"
      onError={() => setFailedId(frameId)}
    />
  )
}

/** The well per size: xs sits in a table row or menu item, sm leads a list
 *  row, md is a strip tile that takes its column's width. */
const THUMB_SIZE = {
  xs: 'h-[22px] w-[34px]',
  sm: 'h-10 w-16',
  md: 'h-24 w-full',
} as const

type FrameThumbSize = keyof typeof THUMB_SIZE

/** What each size says when there is nothing to preview; xs is too small for words. */
const THUMB_EMPTY: Record<FrameThumbSize, ReactNode> = {
  xs: null,
  sm: 'empty',
  md: 'empty canvas',
}

/**
 * A `FramePreview` in a boxed well: the one thumbnail a list row, menu item
 * or frame strip shows, so every list draws the same corner, ring and fill.
 */
export function FrameThumb({
  frameId,
  size = 'sm',
  empty = THUMB_EMPTY[size],
  className,
}: {
  frameId?: string | null
  size?: FrameThumbSize
  /** what an empty well says; defaults per size, `null` for a plain blank */
  empty?: ReactNode
  /** placement only (margins, flex); the box comes from `size` */
  className?: string
}) {
  return (
    <span
      className={cn(
        'grid flex-none place-items-center overflow-hidden rounded-row bg-paper-deep shadow-ring',
        THUMB_SIZE[size],
        className,
      )}
      aria-hidden
    >
      <FramePreview frameId={frameId} empty={empty} className="text-micro" />
    </span>
  )
}
