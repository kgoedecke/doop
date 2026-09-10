import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'
import * as TabsPrimitive from '@radix-ui/react-tabs'

import { Button } from './button'
import { CollapsibleTrigger } from './collapsible'
import { Tooltip } from './tooltip'
import { XIcon } from './icons'

/* The canvas rails (Activity, Inspector). On a wide screen they float over the
   board; inside a mobile Sheet they fill it. That used to be a `.side-panel`
   class the page reached back through with descendant selectors — it is a prop
   now, so the panel's two shapes live in one place. */
const panelVariants = cva('flex min-w-0 flex-col overflow-hidden bg-surface', {
  variants: {
    surface: {
      floating: 'absolute z-[35] rounded-[14px] border border-line shadow-pop',
      /* filling a Sheet: no chrome of its own, the sheet provides it */
      inline: 'h-full w-full rounded-none border-0 shadow-none',
    },
  },
  defaultVariants: { surface: 'floating' },
})

function Panel({ className, surface, ...props }: React.ComponentProps<'div'> & VariantProps<typeof panelVariants>) {
  return <div data-slot="panel" className={cn(panelVariants({ surface, className }))} {...props} />
}

/** Sticky header: title or tabs on the left, actions on the right. */
function PanelHeader({ className, ...props }: React.ComponentProps<'header'>) {
  return (
    <header
      data-slot="panel-header"
      className={cn(
        'sticky top-0 z-[2] flex shrink-0 items-center justify-between gap-1 border-b border-line-soft bg-surface px-4 py-[13px] font-mono text-[11.5px] font-medium uppercase tracking-[0.1em] text-ink-soft',
        className,
      )}
      {...props}
    />
  )
}

function PanelBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="panel-body"
      className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', className)}
      {...props}
    />
  )
}

/** The uppercase tab strip some panel headers carry instead of a title. Goes
 *  inside a <PanelTabsRoot> together with the PanelTabPanels it switches. */
function PanelTabsRoot({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="panel-tabs-root"
      className={cn('flex min-h-0 flex-1 flex-col', className)}
      {...props}
    />
  )
}

function PanelTabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  /* min-w-0 so a long tab strip shrinks instead of shoving the close button
     out through the panel's padding */
  return <TabsPrimitive.List data-slot="panel-tabs" className={cn('flex min-w-0 gap-0.5', className)} {...props} />
}

function PanelTab({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="panel-tab"
      className={cn(
        'rounded-sm px-2 py-[3px] font-mono text-[11px] font-medium uppercase tracking-[0.09em] text-ink-faint transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink data-[state=active]:bg-paper-deep data-[state=active]:text-ink',
        className,
      )}
      {...props}
    />
  )
}

function PanelTabPanel({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="panel-tab-panel"
      className={cn('flex min-h-0 flex-1 flex-col outline-none', className)}
      {...props}
    />
  )
}

/** A full-width row that expands the section under it. Wrap it and its panel
 *  in <Collapsible> — Radix does the aria-controls/expanded wiring. */
function PanelDisclosure({ className, ...props }: React.ComponentProps<typeof CollapsibleTrigger>) {
  return (
    <CollapsibleTrigger
      data-slot="panel-disclosure"
      className={cn(
        'w-full border-t border-line-soft bg-transparent px-3.5 py-2.5 font-mono text-[11.5px] text-ink-faint hover:text-ink',
        className,
      )}
      {...props}
    />
  )
}

/** The small ✕ that closes a rail. Draws its own glyph: a text ✕ sits on a
 *  baseline and never centres in the button, the icon does. */
function PanelClose({
  className,
  label = 'Close',
  children: _children,
  ...props
}: React.ComponentProps<'button'> & { label?: string }) {
  return (
    <Tooltip label={label} side="bottom" align="end">
      <Button
        variant="bare"
        size="icon-sm"
        aria-label={label}
        className={cn('shrink-0 text-ink-faint hover:bg-paper-deep hover:text-ink', className)}
        {...props}
      >
        <XIcon className="size-[13px]" strokeWidth={2.2} />
      </Button>
    </Tooltip>
  )
}

export {
  Panel,
  PanelHeader,
  PanelBody,
  PanelTabsRoot,
  PanelTabs,
  PanelTab,
  PanelTabPanel,
  PanelClose,
  PanelDisclosure,
  panelVariants,
}
