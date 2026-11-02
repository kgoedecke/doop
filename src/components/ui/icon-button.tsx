import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/** The frosted chip over a preview: the surface at 72%, blurred, edged by the
 *  elevation ring rather than a border. The tile's actions button wears it,
 *  and so do the static agent marks beside it. */
const frostedSurface = 'bg-surface/72 corner-squircle shadow-elevation-1 backdrop-blur-[6px]'

/* A glyph in a square: the rail's search and collapse controls, a row's
   "more" button, a modal's close. Quiet by default — no ring, the paper-deep
   fill appears on hover and stays while it is `on` (a toggled control, an open
   menu). The label is what the button says to a screen reader and the tooltip,
   so it is not optional. */
const iconButtonVariants = cva(
  [
    'inline-grid flex-none cursor-pointer place-items-center',
    'transition-[background-color,color,box-shadow,opacity] duration-normal ease-out-quad',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
    'disabled:pointer-events-none disabled:opacity-45',
  ],
  {
    variants: {
      variant: {
        quiet: 'text-ink-soft hover:bg-paper-deep hover:text-ink data-[on]:bg-paper-deep data-[on]:text-ink',
        /* a row's remove control: the failure red only under the pointer */
        danger: 'text-ink-soft hover:bg-accent-ink/10 hover:text-accent-ink',
        /* the one ink action of a composer (send) */
        primary: 'bg-ink text-paper hover:bg-ink/85 active:bg-ink',
        /* over a preview image: the frosted chip, lifted on hover */
        frosted: cn(frostedSurface, 'text-ink hover:shadow-elevation-1-hover focus-visible:shadow-elevation-1-focus'),
      },
      /* sm sits in a 30px header row, md is the narrow rail's and the row-action
         square, lg is a composer's send */
      size: { sm: 'size-6 rounded-row', md: 'size-8 rounded-row', lg: 'size-[34px] rounded-control' },
      shape: { square: '', round: 'rounded-full' },
    },
    defaultVariants: { variant: 'quiet', size: 'md', shape: 'square' },
  },
)

type IconButtonProps = Omit<React.ComponentProps<'button'>, 'aria-label'> &
  VariantProps<typeof iconButtonVariants> & {
    /** required: the glyph has no text of its own */
    'aria-label': string
    /** the pressed state of a toggle, or the open state of what it reveals */
    on?: boolean
  }

const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, variant, size, shape, on = false, type, title, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      data-slot="icon-button"
      data-on={on || undefined}
      aria-pressed={on || undefined}
      title={title ?? props['aria-label']}
      className={cn(iconButtonVariants({ variant, size, shape, className }))}
      {...props}
    />
  )
})

export { IconButton, iconButtonVariants, frostedSurface }
