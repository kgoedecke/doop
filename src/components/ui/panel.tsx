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
      floating: 'pointer-events-auto absolute z-[35] rounded-[14px] shadow-float',
      /* filling a Sheet: no chrome of its own, the sheet provides it */
      inline: 'h-full w-full rounded-none border-0 shadow-none',
    },
  },
  defaultVariants: { surface: 'floating' },
})

export interface PanelResize {
  label: string
  edge: 'left' | 'right'
  width: number
  min: number
  max: number
  onResize: (width: number) => void
}

function Panel({
  className,
  surface,
  resize,
  style,
  children,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof panelVariants> & { resize?: PanelResize }) {
  const drag = React.useRef<{ x: number; width: number } | null>(null)
  const resizing = surface !== 'inline' ? resize : undefined
  const setWidth = (width: number) => {
    if (resizing) resizing.onResize(Math.round(Math.max(resizing.min, Math.min(resizing.max, width))))
  }

  return (
    <div
      data-slot="panel"
      className={cn(panelVariants({ surface, className }))}
      style={resizing ? { ...style, width: resizing.width } : style}
      {...props}
    >
      {children}
      {resizing && (
        <div
          role="separator"
          tabIndex={0}
          aria-label={resizing.label}
          aria-orientation="vertical"
          aria-valuemin={resizing.min}
          aria-valuemax={resizing.max}
          aria-valuenow={resizing.width}
          className={cn(
            'absolute inset-y-2 z-10 w-1.5 touch-none cursor-col-resize rounded-full focus-visible:bg-ink/20 focus-visible:outline-none',
            resizing.edge === 'right' ? 'right-0' : 'left-0',
          )}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.preventDefault()
            e.stopPropagation()
            drag.current = { x: e.clientX, width: resizing.width }
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            if (!drag.current) return
            e.stopPropagation()
            const delta = (e.clientX - drag.current.x) * (resizing.edge === 'right' ? 1 : -1)
            setWidth(drag.current.width + delta)
          }}
          onPointerUp={(e) => {
            drag.current = null
            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
          }}
          onLostPointerCapture={() => {
            drag.current = null
          }}
          onPointerCancel={() => {
            drag.current = null
          }}
          onKeyDown={(e) => {
            const direction = resizing.edge === 'right' ? 1 : -1
            let width: number
            if (e.key === 'ArrowLeft') width = resizing.width - 10 * direction
            else if (e.key === 'ArrowRight') width = resizing.width + 10 * direction
            else if (e.key === 'Home') width = resizing.min
            else if (e.key === 'End') width = resizing.max
            else return
            e.preventDefault()
            e.stopPropagation()
            setWidth(width)
          }}
        />
      )}
    </div>
  )
}

/** Sticky header: title or tabs on the left, actions on the right. Sentence
 *  case in the UI sans — the white system has no uppercase mono headers. */
function PanelHeader({ className, ...props }: React.ComponentProps<'header'>) {
  return (
    <header
      data-slot="panel-header"
      className={cn(
        'sticky top-0 z-[2] flex h-[42px] shrink-0 items-center justify-between gap-2 border-b border-line-soft bg-surface pr-2.5 pl-3.5 text-[12.5px] font-medium text-ink',
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

/** The tab strip some panel headers carry instead of a title. Goes inside a
 *  <PanelTabsRoot> together with the PanelTabPanels it switches. */
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

/* forwards its ref so a Tooltip can anchor on an icon-only tab */
const PanelTab = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentProps<typeof TabsPrimitive.Trigger>
>(function PanelTab({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      data-slot="panel-tab"
      className={cn(
        'inline-flex h-[26px] items-center gap-[7px] whitespace-nowrap rounded-[8px] px-2 text-[12px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink data-[state=active]:bg-paper-deep data-[state=active]:font-medium data-[state=active]:text-ink',
        className,
      )}
      {...props}
    />
  )
})

/** A tab with an icon, and a label that unfolds beside it while the tab is the
 *  active one (an icon strip). The label stays in the DOM when folded, so
 *  the tab keeps its accessible name; `title` covers the sighted hover. */
const PanelIconTab = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<typeof TabsPrimitive.Trigger> & {
    icon: React.ReactNode
    /** a count pinned to the tab's corner, outside the folding label */
    badge?: React.ReactNode
  }
>(function PanelIconTab({ className, icon, badge, children, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      data-slot="panel-icon-tab"
      className={cn(
        'group relative inline-flex h-[26px] shrink-0 items-center rounded-[8px] px-2 font-sans text-[12px] font-normal normal-case tracking-normal text-ink-soft transition-[background-color,color] duration-200 hover:bg-paper-deep/60 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink data-[state=active]:bg-paper-deep data-[state=active]:font-medium data-[state=active]:text-ink motion-reduce:transition-none',
        className,
      )}
      {...props}
    >
      <span className="grid size-3.5 shrink-0 place-items-center [&>svg]:size-3.5">{icon}</span>
      {/* a 0fr → 1fr grid track is the one width animation CSS can run without
          knowing the label's width */}
      <span className="grid grid-cols-[0fr] opacity-0 transition-[grid-template-columns,opacity] duration-200 ease-out group-data-[state=active]:grid-cols-[1fr] group-data-[state=active]:opacity-100 motion-reduce:transition-none">
        <span className="min-w-0 overflow-hidden">
          <span className="block whitespace-nowrap pl-[7px]">{children}</span>
        </span>
      </span>
      {badge}
    </TabsPrimitive.Trigger>
  )
})

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
        'flex w-full items-center gap-2 border-t border-line-soft bg-transparent px-3 py-2.5 text-left text-[12px] text-ink-soft hover:text-ink',
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
        className={cn('size-7 shrink-0 rounded-[7px] text-ink-faint hover:bg-paper-deep hover:text-ink', className)}
        {...props}
      >
        <XIcon className="size-3.5" />
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
  PanelIconTab,
  PanelTabPanel,
  PanelClose,
  PanelDisclosure,
  panelVariants,
}
