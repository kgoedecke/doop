import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/* A tile is a card with a cover image over a short body: a canvas on Home, a
   design in the Community gallery, a canvas in the admin index. The shell is
   the raised Card surface with the panel corner; `frosted` lets the dotted
   page show through at 72% and lifts on hover, `solid` is the plain surface. */
const tileVariants = cva(
  'group relative z-[2] flex min-w-0 transform-gpu flex-col overflow-hidden rounded-panel corner-squircle text-left text-ink shadow-elevation-1',
  {
    variants: {
      tone: {
        frosted:
          'bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] backdrop-blur-[6px] transition-[box-shadow] duration-normal ease-out-quad hover:shadow-elevation-1-hover',
        solid: 'bg-surface',
      },
    },
    defaultVariants: { tone: 'frosted' },
  },
)

function Tile({ className, tone, ...props }: React.ComponentProps<'div'> & VariantProps<typeof tileVariants>) {
  return <div data-slot="tile" className={cn(tileVariants({ tone, className }))} {...props} />
}

/* the cover's proportions, as literal classes so Tailwind sees them */
const TILE_ASPECTS = {
  '5/3': 'aspect-[5/3]',
  '16/10': 'aspect-[16/10]',
  '4/3': 'aspect-[4/3]',
} as const

type TileAspect = keyof typeof TILE_ASPECTS

/** The cover well: a frame preview centred on the dotted paper, with room for
 *  overlays (an agent stack, a frame count) pinned to its corners. */
function TileCover({ className, aspect = '5/3', ...props }: React.ComponentProps<'div'> & { aspect?: TileAspect }) {
  return (
    <div
      data-slot="tile-cover"
      className={cn(
        'relative grid place-items-center overflow-hidden border-b border-line-soft',
        '[background:radial-gradient(circle,var(--dot)_1px,transparent_1px)_0_0/18px_18px,var(--paper-deep)]',
        TILE_ASPECTS[aspect],
        className,
      )}
      {...props}
    />
  )
}

function TileBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="tile-body" className={cn('px-3 pb-3 pt-2.5', className)} {...props} />
}

/** The caption line under a title: its parts joined by a quiet `·`. Empty
 *  parts (`false`, `null`) drop out, so a conditional part never leaves a
 *  stray separator. `trailing` (a badge, an action) follows without one. */
function MetaLine({
  className,
  children,
  trailing,
  ...props
}: React.ComponentProps<'div'> & { trailing?: React.ReactNode }) {
  const parts = React.Children.toArray(children)
  return (
    <div
      data-slot="meta-line"
      className={cn('flex min-w-0 items-center gap-1.5 text-caption text-ink-faint', className)}
      {...props}
    >
      {parts.map((part, i) => (
        <React.Fragment key={React.isValidElement(part) && part.key !== null ? part.key : i}>
          {i > 0 && (
            <span aria-hidden className="opacity-60">
              ·
            </span>
          )}
          {part}
        </React.Fragment>
      ))}
      {trailing}
    </div>
  )
}

export { Tile, TileCover, TileBody, MetaLine, tileVariants, TILE_ASPECTS, type TileAspect }
