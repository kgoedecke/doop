import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/* Status marker. Round for a state (a task's outcome), square for an actor
   (an agent's colour swatch) — the shape is how you tell the two apart at
   8px, so it is a variant rather than an ad-hoc border radius. */
const dotVariants = cva('inline-block shrink-0', {
  variants: {
    shape: { round: 'rounded-full', square: 'rounded-sm' },
    tone: {
      /* takes its colour from an agent's assigned hue via `style` */
      current: 'bg-current',
      idle: 'bg-ink-faint',
      running: 'bg-brand animate-[status-pulse_1.6s_ease-in-out_infinite]',
      done: 'bg-success',
      failed: 'bg-accent-ink',
      muted: 'bg-line',
    },
    size: { sm: 'size-1.5', md: 'size-2', lg: 'size-2.5' },
  },
  defaultVariants: { shape: 'round', tone: 'current', size: 'md' },
})

function Dot({
  className,
  shape,
  tone,
  size,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof dotVariants>) {
  return <span data-slot="dot" aria-hidden className={cn(dotVariants({ shape, tone, size, className }))} {...props} />
}

export { Dot, dotVariants }
