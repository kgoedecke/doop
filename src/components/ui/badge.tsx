import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from '@radix-ui/react-slot'

import { cn } from '@/lib/utils'

/* The chip: a small mono-type tag. Doop uses it for counts, roles, states and
   model names, so the tones below are the vocabulary — nothing should invent
   its own pill colour. */
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-[7px] py-0.5 font-mono text-[11px] leading-[1.5]',
  {
    variants: {
      tone: {
        default: 'border-line bg-paper-deep text-ink-soft',
        admin: 'border-accent-ink/40 bg-accent-ink/[0.08] text-accent-ink',
        banned: 'border-warning-ink/35 bg-warning/[0.12] text-warning-ink',
        accent: 'border-accent-ink/40 bg-transparent text-accent-ink',
        outline: 'border-line bg-transparent text-ink-soft',
      },
      interactive: {
        true: 'cursor-pointer transition-colors hover:bg-current/10',
        false: '',
      },
    },
    defaultVariants: { tone: 'default', interactive: false },
  },
)

function Badge({
  className,
  tone,
  interactive,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'span'
  return <Comp data-slot="badge" className={cn(badgeVariants({ tone, interactive, className }))} {...props} />
}

export { Badge, badgeVariants }
