import { cn } from '@/lib/utils'

/** The Disc-D: a half-disc with a dot resting under its stem, reading as
 *  Doop's initial — the frame and the cursor beside it. (Identity round 10.)
 *
 *  The tile is part of the mark, so every call site gets the same lockup
 *  without having to supply its own background. */
export function Logo({ className = 'size-[30px]' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 200 200" aria-hidden>
      <rect width="200" height="200" rx="48" fill="#111110" />
      <g fill="#fdfdfc" transform="translate(14,0)">
        <path d="M78 36 A 64 64 0 0 1 78 164 Z" />
        <circle cx="50" cy="146" r="19" />
      </g>
    </svg>
  )
}

/* the mark's own box, and the one the hop needs: 12 units of headroom above
   the stem so the resting layout already leaves room for the dot's arc */
const MARK_BOX = { x: 42, y: 32, w: 118, h: 137 }
const HOP_HEADROOM = 12

/** The bare Disc-D, no tile: the glyph that stands for a Doop agent inline
 *  next to text (presence chips, cursor pills, activity rows). Inherits the
 *  text colour unless a fill is given. The viewBox crops to the mark itself
 *  so it sits on the text baseline like a letter.
 *
 *  `animated` makes the dot hop (the loading mark, as the home greeting wears
 *  it; still under reduced motion). `size` is the height in px, or `fill` to
 *  take the box a parent sizes, for a mark that changes size across
 *  breakpoints. */
export function DoopMark({
  size = 13,
  color,
  animated = false,
  className = 'mr-px inline-block align-[-2px]',
}: {
  size?: number | 'fill'
  color?: string
  animated?: boolean
  className?: string
}) {
  const top = animated ? MARK_BOX.y - HOP_HEADROOM : MARK_BOX.y
  const height = animated ? MARK_BOX.h + HOP_HEADROOM : MARK_BOX.h
  return (
    <svg
      className={cn(animated && 'overflow-visible', className)}
      /* inline so Button's descendant-svg rule (16px unless a size- class) cannot override it */
      style={
        size === 'fill'
          ? { width: '100%', height: '100%' }
          : { width: Math.round((size * MARK_BOX.w) / height), height: size }
      }
      viewBox={`${MARK_BOX.x} ${top} ${MARK_BOX.w} ${height}`}
      fill={color ?? 'currentColor'}
      aria-hidden
    >
      <g transform="translate(14,0)">
        <path d="M78 36 A 64 64 0 0 1 78 164 Z" />
        <circle
          className={cn(
            animated &&
              'origin-center animate-[disc-hop_2.4s_cubic-bezier(.5,0,.5,1)_infinite] [transform-box:fill-box] motion-reduce:animate-none',
          )}
          cx="50"
          cy="146"
          r="19"
        />
      </g>
    </svg>
  )
}
