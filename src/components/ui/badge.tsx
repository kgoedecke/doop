import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from '@radix-ui/react-slot'

import { cn } from '@/lib/utils'

/* The chip: a small mono-type tag. Doop uses it for counts, roles, states and
   model names, so the tones below are the vocabulary — nothing should invent
   its own pill colour. `shape="pill"` is the rounder, roomier tag a review
   header names its source with (a repo, a site, a Figma file); it truncates. */
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 whitespace-nowrap border text-micro font-medium leading-[1.4]',
  {
    variants: {
      tone: {
        default: 'border-transparent bg-transparent text-ink-faint shadow-[inset_0_0_0_0.75px_var(--line)]',
        admin: 'border-accent-ink/40 bg-accent-ink/[0.08] text-accent-ink',
        banned: 'border-warning-ink/35 bg-warning/[0.12] text-warning-ink',
        accent: 'border-accent-ink/40 bg-transparent text-accent-ink',
        outline: 'border-line bg-transparent text-ink-soft',
        /* the one highlighted option in a set ("Popular") */
        brand: 'border-transparent bg-brand text-white',
        /* a confirmed state ("verified") */
        success: 'border-success/35 bg-success/10 text-success-ink',
      },
      shape: {
        tag: 'rounded-tag px-1.25 py-px',
        /* inline-block, not flex: an ellipsis only applies to a block's own text */
        pill: 'inline-block max-w-full truncate rounded-pill px-[9px] py-[5px] sm:max-w-[240px]',
      },
      interactive: {
        true: 'cursor-pointer transition-colors hover:bg-current/10',
        false: '',
      },
    },
    /* the neutral pill sits on a paper fill rather than the hairline alone */
    compoundVariants: [{ tone: 'default', shape: 'pill', className: 'bg-paper' }],
    defaultVariants: { tone: 'default', shape: 'tag', interactive: false },
  },
)

function Badge({
  className,
  tone,
  shape,
  interactive,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'span'
  return <Comp data-slot="badge" className={cn(badgeVariants({ tone, shape, interactive, className }))} {...props} />
}

export { Badge, badgeVariants }
