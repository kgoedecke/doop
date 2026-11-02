import * as React from 'react'
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/* The plan/model pickers: a row of soft pills where the chosen one snaps to
   the ink hairline instead of the soft one. `idle` is the read-only form used on rows that
   only list what a connection can do. `sm` is the compact row: the gallery's
   shelf filter, the publish shelf picker. */
const toggleChipVariants = cva(
  'inline-flex items-center gap-1.75 rounded-row border font-medium transition-[background-color,color,box-shadow,border-color]',
  {
    variants: {
      state: {
        off: 'cursor-pointer border-transparent bg-paper-deep text-ink-soft hover:text-ink',
        on: 'border-ink bg-surface font-semibold text-ink',
        idle: 'cursor-default border-transparent bg-paper-deep text-ink-soft opacity-75',
      },
      size: {
        md: 'px-3 py-2 text-body/4',
        sm: 'px-2.5 py-1 text-label',
      },
    },
    defaultVariants: { state: 'off', size: 'md' },
  },
)

/** A row of chips where exactly one is chosen. Arrow keys move between them. */
function ToggleChipGroup({
  className,
  value,
  onValueChange,
  ...props
}: Omit<React.ComponentProps<typeof ToggleGroupPrimitive.Root>, 'type' | 'value' | 'defaultValue' | 'onValueChange'> & {
  value: string
  onValueChange: (value: string) => void
}) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      data-slot="toggle-chip-group"
      value={value}
      onValueChange={(next) => next && onValueChange(next)}
      className={cn('flex flex-wrap gap-[9px]', className)}
      {...props}
    />
  )
}

/** One chip inside a ToggleChipGroup. */
function ToggleChipItem({
  className,
  size,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> & Pick<VariantProps<typeof toggleChipVariants>, 'size'>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-chip"
      className={cn(
        toggleChipVariants({ state: 'off', size }),
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink data-[state=on]:border-ink data-[state=on]:bg-surface data-[state=on]:font-semibold data-[state=on]:text-ink',
        className,
      )}
      {...props}
    />
  )
}

/** A chip that only reports state — the capability lists on unconnected rows. */
function ToggleChip({
  className,
  state,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof toggleChipVariants>) {
  return <span data-slot="toggle-chip" className={cn(toggleChipVariants({ state, className }))} {...props} />
}

export { ToggleChip, ToggleChipGroup, ToggleChipItem, toggleChipVariants }
