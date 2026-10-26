import * as React from 'react'

import { cn } from '@/lib/utils'
import { Tooltip } from './tooltip'

/* The floating island of quiet controls over the canvas — the tool rail, the
   zoom pill. Its buttons grow to a 40px touch target on phones — small
   enough to read as a toolbar, big enough to hit. */
function Toolbar({
  orientation = 'horizontal',
  className,
  ...props
}: React.ComponentProps<'div'> & {
  /** vertical: the 40px column the canvas editor pins to its sides */
  orientation?: 'horizontal' | 'vertical'
}) {
  return (
    <div
      data-slot="toolbar"
      role="toolbar"
      aria-orientation={orientation}
      className={cn(
        'relative flex items-center gap-0.5 rounded-[12px] bg-surface p-[5px] shadow-float',
        orientation === 'vertical' && 'w-10 flex-col',
        className,
      )}
      {...props}
    />
  )
}

/** Forwards its ref so it can anchor a Radix popper (`DropdownMenuTrigger
 *  asChild`, `Tooltip`): without the ref the menu never gets positioned. */
const ToolbarButton = React.forwardRef<HTMLButtonElement, React.ComponentProps<'button'>>(function ToolbarButton(
  { className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      data-slot="toolbar-button"
      className={cn(
        'grid min-h-10 min-w-10 place-items-center rounded-[7px] border-0 bg-transparent px-1.5 text-[12px] text-ink-soft transition-[color,background-color,scale] duration-150 ease-out-quint hover:bg-paper-deep hover:text-ink active:scale-95 motion-reduce:transition-none sm:size-7 sm:min-h-0 sm:min-w-0 sm:px-0 [&_svg]:size-3.5',
        className,
      )}
      {...props}
    />
  )
})

/** An icon-only toolbar button named by its tooltip: `label` is both the
 *  tooltip and the accessible name. Children may include a `ToolbarDot`. */
function ToolbarControl({
  label,
  side = 'left',
  className,
  ...props
}: Omit<React.ComponentProps<typeof ToolbarButton>, 'aria-label'> & {
  label: string
  side?: 'left' | 'right' | 'top' | 'bottom'
}) {
  return (
    <Tooltip label={label} side={side}>
      {/* a disabled button swallows pointer events — the span keeps the tooltip */}
      <span className="inline-flex">
        {/* relative: the corner for a ToolbarDot */}
        <ToolbarButton aria-label={label} className={cn('relative', className)} {...props} />
      </span>
    </Tooltip>
  )
}

/** The small live dot on a toolbar button's corner: an agent at work, a
 *  message waiting, a failed run. The colour comes in through `className`. */
function ToolbarDot({ className }: { className: string }) {
  return (
    <span
      data-slot="toolbar-dot"
      className={cn('absolute -top-px -right-px size-2 rounded-full border-[1.5px] border-surface', className)}
    />
  )
}

/** The fill behind the pressed button, as one element that slides and
 *  resizes to the next press instead of each button lighting up on its own.
 *  It measures `[aria-pressed="true"]` in its toolbar whenever `activeKey`
 *  changes and whenever the toolbar re-lays out (the rail flips from a row on
 *  phones to a column on desktop). The first measurement is applied without
 *  a transition, so the pill never slides in from the corner on mount. */
function ToolbarHighlight({ activeKey, className }: { activeKey: string; className?: string }) {
  const ref = React.useRef<HTMLSpanElement>(null)
  const [ready, setReady] = React.useState(false)

  React.useLayoutEffect(() => {
    const pill = ref.current
    const bar = pill?.parentElement
    if (!pill || !bar) return
    const place = () => {
      const active = bar.querySelector<HTMLElement>('[aria-pressed="true"]')
      if (!active) {
        pill.style.opacity = '0'
        return
      }
      pill.style.opacity = '1'
      pill.style.translate = `${active.offsetLeft}px ${active.offsetTop}px`
      pill.style.width = `${active.offsetWidth}px`
      pill.style.height = `${active.offsetHeight}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [activeKey])

  /* arm the transition one frame after the first placement */
  React.useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true))
    return () => cancelAnimationFrame(id)
  }, [])

  return (
    <span
      ref={ref}
      aria-hidden
      data-slot="toolbar-highlight"
      className={cn(
        'pointer-events-none absolute top-0 left-0 rounded-[7px] bg-paper-deep opacity-0',
        ready &&
          'transition-[translate,width,height,opacity] duration-250 ease-out-quint motion-reduce:transition-none',
        className,
      )}
    />
  )
}

function ToolbarDivider({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="toolbar-divider" className={cn('mx-0.5 h-[18px] w-px bg-line-soft', className)} {...props} />
}

/** A read-only readout between controls (the zoom percentage). */
const ToolbarValue = React.forwardRef<HTMLSpanElement, React.ComponentProps<'span'>>(function ToolbarValue(
  { className, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      data-slot="toolbar-value"
      className={cn('min-w-[44px] px-1 text-center font-mono text-[12px] text-ink sm:min-w-[48px]', className)}
      {...props}
    />
  )
})

export { Toolbar, ToolbarButton, ToolbarControl, ToolbarDivider, ToolbarDot, ToolbarHighlight, ToolbarValue }
