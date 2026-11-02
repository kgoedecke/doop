import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from '@radix-ui/react-slot'

import { cn } from '@/lib/utils'

/* Doop's button: a white surface drawn by a 1px shadow ring rather than a
   border, with one black primary per screen. Pressing a control deepens its
   fill instead of sinking it. That restraint lives in the base and every
   variant only re-colours it. The border stays in the base (transparent) so
   callers that set a border colour keep working. */
const buttonVariants = cva(
  [
    'inline-flex shrink-0 select-none items-center justify-center gap-1.75 whitespace-nowrap rounded-row',
    'border font-medium transition-[background-color,border-color,color,box-shadow] duration-[120ms]',
    'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40',
    'disabled:pointer-events-none disabled:opacity-45',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        /* the workhorse: white surface, ink hairline, fills on press */
        default: 'border-transparent bg-surface text-ink shadow-ring hover:shadow-ring-hover active:bg-paper-deep',
        primary: 'border-transparent bg-ink text-paper hover:bg-ink/85 active:bg-ink',
        /* quiet sibling: the soft hairline instead of the ink one */
        ghost: 'border-transparent bg-transparent text-ink shadow-ring hover:bg-paper-deep hover:shadow-ring-hover',
        danger: 'border-transparent bg-transparent text-accent-ink shadow-ring hover:bg-accent-ink/10',
        /* bare text action — menu rows, inline destructive links */
        bare: 'border-transparent bg-transparent text-ink-soft hover:bg-paper-deep hover:text-ink',
        'bare-danger': 'border-transparent bg-transparent text-accent-ink hover:bg-accent-ink/10',
        link: 'border-transparent bg-transparent text-ink underline-offset-4 hover:underline',
        /* filled destructive pill — the retry affordance on failed tasks */
        'danger-solid': 'border-accent-ink bg-accent-ink text-white hover:border-ink hover:bg-ink hover:text-paper',
        /* flat ink fill: compact affordances inside cards */
        solid: 'border-transparent bg-ink text-paper hover:bg-ink/90 disabled:opacity-40',
        /* sits on an ink surface — foreground and hover invert with the theme */
        inverse: 'border-transparent bg-transparent text-paper hover:bg-paper/15',
      },
      size: {
        pill: 'rounded-full px-2 py-0.75 text-caption/3.5 font-medium',
        sm: 'px-2.5 py-1.25 text-label/4',
        md: 'px-3.5 py-2 text-body/4',
        lg: 'justify-center px-4 py-2.75 text-copy/5',
        /* the 32px header and toolbar action with a leading glyph (Import, New canvas) */
        bar: 'h-8 rounded-control pl-2.5 pr-3 text-body',
        icon: 'size-9 p-0',
        'icon-sm': 'size-7 rounded-tag p-0',
        /* a text action inside a line of copy or a selection bar ("Clear",
           "Select page", "Codex & other clients →"): no box, no fill, the
           caption step. Pair it with `bare` or `link`. */
        inline: 'h-auto gap-1 rounded-tag p-0 text-caption hover:bg-transparent',
      },
      /* stretches to the container — the mobile default for primary actions */
      block: { true: 'w-full justify-center', false: '' },
    },
    defaultVariants: { variant: 'default', size: 'md', block: false },
  },
)

type ButtonProps = React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, block, asChild = false, type, ...props },
  ref,
) {
  const Comp = asChild ? Slot : 'button'

  return (
    <Comp
      ref={ref}
      data-slot="button"
      /* A bare <button> inside a form is a submit button, so any Button that
         is not explicitly a submit would be activated by Enter in a text
         field — on the sign-in form that meant Enter firing "Forgot
         password?". Default to "button"; forms opt in with type="submit". */
      {...(asChild ? {} : { type: type ?? 'button' })}
      className={cn(buttonVariants({ variant, size, block, className }))}
      {...props}
    />
  )
})

export { Button, buttonVariants }
