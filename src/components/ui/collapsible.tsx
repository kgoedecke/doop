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
        size={12}
        className="flex-none transition-transform duration-150 group-data-[state=open]:rotate-90"
      />
    </CollapsiblePrimitive.Trigger>
  )
}

/** The fold-away aside, in place of a `<details>`: a quiet label that turns
 *  its chevron, and the body under it. The body stays mounted while folded,
 *  as a `<details>` body does, and is hidden by its closed state, so a
 *  command or a link inside it exists before anyone opens it. */
function Disclosure({
  label,
  className,
  triggerClassName,
  contentClassName,
  children,
  ...props
}: Omit<React.ComponentProps<typeof CollapsiblePrimitive.Root>, 'children'> & {
  label: React.ReactNode
  triggerClassName?: string
  contentClassName?: string
  children: React.ReactNode
}) {
  return (
    <Collapsible data-slot="disclosure" className={className} {...props}>
      <CollapsibleTrigger className={cn('justify-start hover:text-ink', triggerClassName)}>{label}</CollapsibleTrigger>
      <CollapsibleContent forceMount className={cn('mt-2 data-[state=closed]:hidden', contentClassName)}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent, Disclosure }
