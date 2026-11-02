import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/* An on/off setting that applies the moment it flips: an automation running,
   a notification on. Brand fill when on, a line-grey track when off, and a
   surface thumb lifted by the ring shadow rather than a border, so it reads in
   both themes. Radix gives it role="switch", aria-checked and Space/Enter. */
const switchVariants = cva(
  'peer group/switch relative inline-flex flex-none cursor-pointer items-center rounded-full transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-brand data-[state=unchecked]:bg-line',
  {
    variants: {
      size: {
        sm: 'h-4 w-[26px]',
        md: 'h-5 w-[34px]',
      },
    },
    defaultVariants: { size: 'md' },
  },
)

const thumbVariants = cva(
  'pointer-events-none block rounded-full bg-surface shadow-ring transition-transform data-[state=unchecked]:translate-x-0.5',
  {
    variants: {
      size: {
        sm: 'size-3 data-[state=checked]:translate-x-3',
        md: 'size-4 data-[state=checked]:translate-x-4',
      },
    },
    defaultVariants: { size: 'md' },
  },
)

function Switch({
  className,
  size,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & VariantProps<typeof switchVariants>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size ?? 'md'}
      className={cn(switchVariants({ size, className }))}
      {...props}
    >
      <SwitchPrimitive.Thumb data-slot="switch-thumb" className={thumbVariants({ size })} />
    </SwitchPrimitive.Root>
  )
}

export { Switch, switchVariants }
