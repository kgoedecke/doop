import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/* Inline status copy: the line under a field, the error a form shows, the
   "saved" confirmation. One place decides what success and failure look like. */
const noteVariants = cva('leading-[1.45]', {
  variants: {
    tone: {
      muted: 'text-ink-faint',
      error: 'text-accent-ink',
      success: 'text-success-ink',
    },
    size: {
      xs: 'text-[11.5px]',
      sm: 'text-[13px]',
    },
  },
  defaultVariants: { tone: 'muted', size: 'xs' },
})

function Note({ className, tone, size, ...props }: React.ComponentProps<'span'> & VariantProps<typeof noteVariants>) {
  return <span data-slot="note" className={cn(noteVariants({ tone, size, className }))} {...props} />
}

export { Note, noteVariants }
