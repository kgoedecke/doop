import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/* The button a card, a list row or an inline text action is made of: the
   browser's button chrome taken away, a focus ring kept, nothing drawn. The
   content is the whole affordance. `focus` says where the ring goes — inside
   a tile whose edge is the card's, or around a free-standing action. */
const pressableVariants = cva('cursor-pointer border-0 bg-transparent text-left focus-visible:outline-none', {
  variants: {
    focus: {
      inset: 'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
      ring: 'focus-visible:ring-2 focus-visible:ring-ring/40',
      none: '',
    },
    /* a tile fills its card; an action sits inline with its neighbours */
    layout: { block: 'block w-full', inline: 'inline-flex items-center' },
  },
  defaultVariants: { focus: 'inset', layout: 'block' },
})

type PressableProps = React.ComponentProps<'button'> & VariantProps<typeof pressableVariants>

const Pressable = React.forwardRef<HTMLButtonElement, PressableProps>(function Pressable(
  { className, focus, layout, type, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      data-slot="pressable"
      className={cn(pressableVariants({ focus, layout, className }))}
      {...props}
    />
  )
})

export { Pressable, pressableVariants }
