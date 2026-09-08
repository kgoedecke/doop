import * as React from 'react'
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible'

import { cn } from '@/lib/utils'
import { ChevronRightIcon } from './icons'

/* A disclosure whose trigger is actually wired to its panel: Radix sets
   aria-controls and aria-expanded on the trigger and hides the content from
   the accessibility tree when closed — which two hand-rolled `{open && …}`
   toggles in the app were not doing. */

const Collapsible = CollapsiblePrimitive.Root
const CollapsibleContent = CollapsiblePrimitive.Content

/** The row you click: a label on the left, a chevron that turns on the right. */
function CollapsibleTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Trigger>) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      className={cn('group flex items-center justify-between gap-2 text-left transition-colors', className)}
      {...props}
    >
      {children}
      <ChevronRightIcon
        aria-hidden
        className="size-3 shrink-0 text-ink-faint transition-transform duration-150 group-data-[state=open]:rotate-90"
      />
    </CollapsiblePrimitive.Trigger>
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
