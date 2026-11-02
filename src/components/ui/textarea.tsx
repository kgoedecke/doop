import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const textareaVariants = cva(
  'w-full min-w-0 resize-none font-[inherit] text-base text-ink outline-none placeholder:text-ink-faint disabled:cursor-not-allowed disabled:opacity-60 md:text-copy/4',
  {
    variants: {
      variant: {
        default:
          'rounded-row border border-line bg-surface px-3 py-2.5 transition-[border-color,box-shadow] focus:border-ink focus:ring-[3px] focus:ring-ink/[0.07]',
        /* the Input well: paper inside a hairline, the surface on focus */
        well: 'rounded-pill border border-line bg-paper px-3 py-2.5 transition-[border-color,background-color] focus:border-ink focus:bg-surface',
        /* an HTML editor: the dark code well at the caption step, tabs two wide */
        code: 'border-0 bg-code p-3 font-mono text-caption/normal text-code-ink [tab-size:2] md:text-caption/normal',
        /* composers: the surrounding card is the field, this is just the text */
        bare: 'border-0 bg-transparent p-0',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<'textarea'> & VariantProps<typeof textareaVariants>
>(function Textarea({ className, variant, ...props }, ref) {
  return <textarea ref={ref} data-slot="textarea" className={cn(textareaVariants({ variant, className }))} {...props} />
})

export { Textarea, textareaVariants }
