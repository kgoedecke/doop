import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/* Doop labels a control three ways, all sentence case in the UI sans: a quiet
   caption over a field in a dense panel, the label step over a form row, or a
   bolder body line that heads a group. (The mono uppercase voice is retired.) */
const labelVariants = cva('block text-ink-soft', {
  variants: {
    variant: {
      caption: 'mb-1 text-caption text-ink-faint',
      form: 'mb-1.5 text-label font-medium text-ink-soft',
      plain: 'mb-1 text-body/4 font-semibold text-ink',
    },
  },
  defaultVariants: { variant: 'caption' },
})

function Label({ className, variant, ...props }: React.ComponentProps<'label'> & VariantProps<typeof labelVariants>) {
  return <label data-slot="label" className={cn(labelVariants({ variant, className }))} {...props} />
}

/** A label + control + optional hint, stacked. */
function Field({
  label,
  hint,
  labelVariant,
  htmlFor,
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  label?: React.ReactNode
  hint?: React.ReactNode
  labelVariant?: VariantProps<typeof labelVariants>['variant']
  htmlFor?: string
}) {
  return (
    <div data-slot="field" className={cn('min-w-0', className)} {...props}>
      {label ? (
        <Label variant={labelVariant} htmlFor={htmlFor}>
          {label}
        </Label>
      ) : null}
      {children}
      {hint ? <p className="mt-1.5 text-xs leading-snug text-ink-faint">{hint}</p> : null}
    </div>
  )
}

export { Field, Label, labelVariants }
