import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'
import { TILE_ASPECTS, type TileAspect } from './tile'

/* The shapes a screen waits on. `tile` is a Tile's footprint (the cover at
   its aspect over a one-line body), `row` a list or table row, `card` a
   settings or integration card. With no shape the caller sizes it. */
const skeletonVariants = cva('animate-[skeleton-pulse_1.4s_ease-in-out_infinite] bg-paper-deep', {
  variants: {
    shape: {
      none: 'rounded-control',
      tile: 'flex flex-col rounded-panel corner-squircle',
      row: 'h-14 rounded-card',
      card: 'min-h-[150px] rounded-card',
    },
  },
  defaultVariants: { shape: 'none' },
})

type SkeletonProps = React.ComponentProps<'div'> &
  VariantProps<typeof skeletonVariants> & {
    /** staggers a grid of them so the wait reads as one wave, not a flash */
    index?: number
    /** `tile` only: the cover aspect of the Tile it stands in for */
    aspect?: TileAspect
  }

/** Loading placeholder — the pulse every empty tile and row shares. */
function Skeleton({ className, shape, index = 0, aspect = '5/3', style, children, ...props }: SkeletonProps) {
  return (
    <div
      data-slot="skeleton"
      className={cn(skeletonVariants({ shape, className }))}
      style={{ animationDelay: `${index * 0.12}s`, ...style }}
      {...props}
    >
      {shape === 'tile' ? (
        <>
          <div aria-hidden className={TILE_ASPECTS[aspect]} />
          <div aria-hidden className="h-[60px]" />
        </>
      ) : (
        children
      )}
    </div>
  )
}

export { Skeleton, skeletonVariants }
