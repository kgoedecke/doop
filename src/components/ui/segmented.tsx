import * as React from 'react'
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group'

import { cn } from '@/lib/utils'

/* One-of-N switches: the canvas's Canvas/Board views, the dashboard's
   grid/list, the agent's model tier. Radix ToggleGroup makes the row a single
   tab stop that the arrow keys move through — the hand-rolled buttons were
   neither — and drives the selected look off data-state instead of a prop a
   caller could forget to pass. Deselection is swallowed: these switches always
   have exactly one answer. */
function Segmented({
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
      data-slot="segmented"
      value={value}
      onValueChange={(next) => next && onValueChange(next)}
      className={cn('flex gap-px rounded-pill bg-paper-deep p-0.75', className)}
      {...props}
    />
  )
}

function SegmentedItem({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="segmented-item"
      className={cn(
        'min-h-[30px] flex-1 rounded-row border-0 bg-transparent px-3 py-1 text-label/3.5 font-normal text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink data-[state=on]:bg-surface data-[state=on]:font-medium data-[state=on]:text-ink data-[state=on]:shadow-ring sm:min-h-0 sm:flex-none',
        className,
      )}
      {...props}
    />
  )
}

/** Icon-only variant: a bordered shell of square buttons (grid / list). */
function SegmentedIcons({ className, ...props }: React.ComponentProps<typeof Segmented>) {
  return <Segmented className={cn('gap-0 overflow-hidden bg-surface', className)} {...props} />
}

function SegmentedIconItem({ className, ...props }: React.ComponentProps<typeof SegmentedItem>) {
  return (
    <SegmentedItem
      className={cn(
        'grid min-h-[30px] flex-none place-items-center rounded-row px-2.75 text-ink-faint data-[state=on]:bg-paper-deep data-[state=on]:text-ink data-[state=on]:shadow-none sm:min-h-0 sm:py-1.75',
        className,
      )}
      {...props}
    />
  )
}

export { Segmented, SegmentedItem, SegmentedIcons, SegmentedIconItem }
