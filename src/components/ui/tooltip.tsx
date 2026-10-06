import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'

import { cn } from '@/lib/utils'

/* Labels for controls that show an icon and nothing else. A `title` attribute
   would do the same job in a browser's own styling, on its own ~1s delay, and
   not at all on touch; this one matches the app, opens promptly, and follows
   the control when the canvas is scrolled or zoomed. */

function TooltipProvider({ delayDuration = 250, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />
}

/** Wraps a single focusable child. `label` is the text; everything else is
 *  positioning, which Radix handles. */
function Tooltip({
  label,
  side = 'top',
  align = 'center',
  children,
  className,
  ...props
}: Omit<React.ComponentProps<typeof TooltipPrimitive.Content>, 'content'> & {
  label: React.ReactNode
  children: React.ReactNode
}) {
  if (!label) return <>{children}</>
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          data-slot="tooltip"
          side={side}
          align={align}
          sideOffset={7}
          collisionPadding={8}
          className={cn(
            'z-[90] max-w-[260px] rounded-[7px] bg-ink px-[9px] py-[5px] text-[11px] font-semibold leading-snug text-paper',
            'animate-[chip-in_0.12s_ease] data-[state=closed]:animate-none',
            className,
          )}
          {...props}
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

export { Tooltip, TooltipProvider }
