import * as React from 'react'

import { cn } from '@/lib/utils'

/** A numbered how-to: each `Step` wears its number in a 24px paper disc.
 *  The numbers come from a CSS counter, so steps are written in order and
 *  never numbered by hand. */
function Steps({ className, ...props }: React.ComponentProps<'ol'>) {
  return (
    <ol
      data-slot="steps"
      className={cn('flex flex-col gap-3 text-copy [counter-reset:doop-step]', className)}
      {...props}
    />
  )
}

function Step({ className, children, ...props }: React.ComponentProps<'li'>) {
  return (
    <li data-slot="step" className={cn('flex items-center gap-3 [counter-increment:doop-step]', className)} {...props}>
      <span
        aria-hidden
        className="grid size-6 flex-none place-items-center rounded-full bg-paper-deep text-label before:content-[counter(doop-step)]"
      />
      <span className="min-w-0">{children}</span>
    </li>
  )
}

export { Steps, Step }
