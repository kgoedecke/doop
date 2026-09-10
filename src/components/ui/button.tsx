import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from '@radix-ui/react-slot'

import { cn } from '@/lib/utils'

/* Doop's button: a hairline-bordered surface that fills rather than moves.
   The editorial system draws elevation with rules, not with drop shadows or
   offset blocks, so pressing a control deepens its fill instead of sinking
   it. That restraint lives in the base and every variant only re-colours it. */
const buttonVariants = cva(
  [
    'inline-flex shrink-0 select-none items-center justify-center gap-[7px] whitespace-nowrap rounded-md',
    'border font-semibold transition-[background-color,border-color,color] duration-[120ms]',
    'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40',
    'disabled:pointer-events-none disabled:opacity-45',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        /* the workhorse: white surface, ink hairline, fills on press */
        default: 'border-ink bg-surface text-ink hover:bg-paper-deep active:bg-line',
        primary: 'border-brand bg-brand text-white hover:border-brand/85 hover:bg-brand/85 active:bg-brand',
        /* quiet sibling: the soft hairline instead of the ink one */
        ghost: 'border-line bg-transparent font-medium text-ink hover:bg-surface',
        danger:
          'border-line bg-transparent font-medium text-accent-ink hover:border-accent-ink/40 hover:bg-accent-ink/10',
        /* bare text action — menu rows, inline destructive links */
        bare: 'border-transparent bg-transparent font-semibold text-ink-soft hover:bg-line-soft hover:text-ink',
        'bare-danger': 'border-transparent bg-transparent font-semibold text-accent-ink hover:bg-accent-ink/10',
        link: 'border-transparent bg-transparent font-semibold text-ink underline-offset-4 hover:underline',
        /* filled destructive pill — the retry affordance on failed tasks */
        'danger-solid': 'border-accent-ink bg-accent-ink text-white hover:border-ink hover:bg-ink hover:text-paper',
        /* flat ink fill: compact affordances inside cards */
        solid: 'border-transparent bg-ink text-paper hover:bg-ink/90 disabled:opacity-40',
        /* sits on a dark surface — the element toolbar over a frame */
        inverse: 'border-transparent bg-transparent text-white hover:bg-white/15',
      },
      size: {
        pill: 'rounded-full px-2 py-[3px] text-[11px] font-bold',
        sm: 'px-2.5 py-[5px] text-xs',
        md: 'px-3.5 py-2 text-[13px]',
        lg: 'justify-center px-4 py-[11px] text-sm',
        icon: 'size-9 p-0',
        'icon-sm': 'size-7 rounded-sm p-0',
      },
      /* Chrome voice: mono, uppercase, tracked out. The app frame speaks in
         it (toolbars, tabs, canvas actions); prose buttons — dialogs, forms,
         anything with a sentence in it — stay in the UI sans. */
      mono: { true: 'font-mono font-medium uppercase tracking-[0.07em]', false: '' },
      /* stretches to the container — the mobile default for primary actions */
      block: { true: 'w-full justify-center', false: '' },
    },
    defaultVariants: { variant: 'default', size: 'md', mono: false, block: false },
  },
)

type ButtonProps = React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, mono, block, asChild = false, type, ...props },
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
      className={cn(buttonVariants({ variant, size, mono, block, className }))}
      {...props}
    />
  )
})

export { Button, buttonVariants }
