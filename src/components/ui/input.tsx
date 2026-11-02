import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/* text-base below md is deliberate: iOS zooms the viewport when a focused
   field is under 16px, and that zoom is what makes a mobile form feel broken.
   The design size comes back at md, where no such thing happens. */
export const fieldVariants = cva(
  'w-full min-w-0 text-base text-ink transition-[border-color,box-shadow] outline-none placeholder:text-ink-faint disabled:cursor-not-allowed disabled:opacity-60',
  {
    variants: {
      variant: {
        default:
          'rounded-row border border-line bg-surface px-3 focus:border-ink focus:ring-[3px] focus:ring-ink/[0.07] md:text-copy',
        /* a filled well in a modal or form: paper inside a hairline, the
           surface and an ink edge on focus, no glow */
        well: 'rounded-pill border border-line bg-paper px-3 focus:border-ink focus:bg-surface md:text-copy',
        /* ids, sizes, coordinates — the inspector's numeric fields */
        mono: 'rounded-control border border-line bg-surface px-2.25 font-mono focus:border-ink md:text-body',
        /* lives inside another bordered shell (search rows, the prompt bar) */
        bare: 'border-0 bg-transparent p-0 focus:ring-0 md:text-copy',
        /* an editable heading: invisible until you hover or focus it */
        title:
          'rounded-control border border-transparent bg-transparent px-2 font-display font-semibold hover:border-line focus:border-ink focus:bg-surface md:text-lead',
      },
      inputSize: {
        sm: 'h-8 py-1',
        md: 'h-9 py-1.5',
        lg: 'h-11 py-2.5',
        auto: '',
      },
    },
    defaultVariants: { variant: 'default', inputSize: 'md' },
  },
)

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'> & VariantProps<typeof fieldVariants>>(
  function Input({ className, variant, inputSize, type, ...props }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        data-slot="input"
        className={cn(fieldVariants({ variant, inputSize, className }))}
        {...props}
      />
    )
  },
)

export { Input }
