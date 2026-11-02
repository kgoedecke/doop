import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'
import { Input } from './input'
import { SearchIcon } from './icons'

/* The search field: a leading glyph, a bare input, room for a shortcut hint.
   `ring` is the 30px pill in a page header (the home list, the gallery);
   `bar` is the palette's top line, a 48px row closed by a hairline. The
   label is the hit area, so a click anywhere in the field focuses the input.
   `size="header"` is the ring field as a DashHeader's search: on a phone it
   drops to its own full-width 40px row under the brand row, from md it is the
   30px pill beside the title, at most 320px wide. */
const searchFieldVariants = cva('flex items-center text-ink-faint', {
  variants: {
    variant: {
      ring: 'h-[30px] gap-[7px] rounded-control bg-surface px-[10px] shadow-ring focus-within:shadow-ring-hover',
      bar: 'h-12 gap-2.5 border-b border-line-soft px-4',
    },
    size: {
      default: '',
      header: 'order-2 h-10 max-w-none flex-1 basis-full md:order-none md:h-[30px] md:max-w-[320px] md:basis-auto',
    },
  },
  defaultVariants: { variant: 'ring', size: 'default' },
})

const ICON_SIZE = { ring: 14, bar: 15 } as const

type SearchFieldProps = Omit<React.ComponentProps<typeof Input>, 'variant' | 'inputSize' | 'size'> &
  VariantProps<typeof searchFieldVariants> & {
    /** classes for the shell; `className` on the input itself is `inputClassName` */
    className?: string
    inputClassName?: string
    /** a shortcut hint (a Kbd) or a clear button after the input */
    trailing?: React.ReactNode
  }

const SearchField = React.forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { className, inputClassName, variant, size, trailing, type, ...props },
  ref,
) {
  const glyph = ICON_SIZE[variant ?? 'ring']
  return (
    <label data-slot="search-field" className={cn(searchFieldVariants({ variant, size, className }))}>
      <SearchIcon width={glyph} height={glyph} aria-hidden />
      <Input
        ref={ref}
        type={type ?? 'text'}
        variant="bare"
        inputSize="auto"
        className={cn('flex-1 md:text-body', inputClassName)}
        {...props}
      />
      {trailing}
    </label>
  )
})

export { SearchField, searchFieldVariants }
