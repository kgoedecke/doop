import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * A suggestion: a 32px ring pill with a small icon tile and a short label,
 * as on the home page's strip. Chips rest faded and come fully on under the
 * pointer, under keyboard focus, or when `on` (the strip's wandering beam);
 * only colour, opacity and shadow change, so a row of them never jitters.
 */
type ChipProps = React.ComponentProps<'button'> & {
  /** a 13px glyph for the tile; omit for a text-only chip */
  icon?: React.ReactNode
  on?: boolean
}

const Chip = React.forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { className, icon, on = false, type, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      data-slot="chip"
      data-on={on || undefined}
      className={cn(
        'relative inline-flex h-8 flex-none cursor-pointer items-center gap-2 whitespace-nowrap rounded-pill bg-surface pl-[11px] pr-[13px] text-body text-ink-soft shadow-ring',
        'transition-[opacity,box-shadow,color] duration-normal ease-out-quad hover:shadow-ring-hover focus-visible:outline-none',
        on ? 'text-ink' : 'opacity-60 hover:opacity-100 focus-visible:opacity-100',
        className,
      )}
      {...props}
    >
      {icon ? <ChipIcon>{icon}</ChipIcon> : null}
      {children}
    </button>
  )
})

/** the 18px tile a chip's glyph sits on: a faint ink wash with a hairline inset */
function ChipIcon({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="chip-icon"
      className={cn(
        'grid size-[18px] flex-none place-items-center rounded-[6px] bg-ink/[0.06] text-ink-soft shadow-[inset_0_0_0_0.75px_rgba(0,0,0,0.12)]',
        className,
      )}
      {...props}
    />
  )
}

export { Chip, ChipIcon }
