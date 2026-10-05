import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/* A boxed message inside a form or panel: the notice a reset link was sent,
   the error a sign-in failed with. Bigger than a Note, quieter than a modal. */
const calloutVariants = cva('rounded-lg border px-3 py-2 text-[13px] leading-[1.45]', {
  variants: {
    tone: {
      neutral: 'border-line bg-line-soft text-ink',
      error: 'border-accent-ink/35 bg-accent-ink/10 text-accent-ink',
      success: 'border-success/35 bg-success/10 text-success-ink',
    },
  },
  defaultVariants: { tone: 'neutral' },
})

function Callout({ className, tone, ...props }: React.ComponentProps<'div'> & VariantProps<typeof calloutVariants>) {
  return <div data-slot="callout" className={cn(calloutVariants({ tone, className }))} {...props} />
}

export { Callout, calloutVariants }
