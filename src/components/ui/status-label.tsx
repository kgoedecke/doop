import * as React from 'react'

import { cn } from '@/lib/utils'
import { Dot } from './dot'

export interface StatusLabelProps extends React.ComponentProps<'span'> {
  /** `done` is the green dot and the softer ink; `muted` the grey dot and faint ink */
  tone?: 'done' | 'muted'
}

/** A dot and a caption saying whether something is live: the "connected /
 *  not connected" line on an integration card or an automation step. */
function StatusLabel({ tone = 'muted', className, children, ...props }: StatusLabelProps) {
  return (
    <span
      data-slot="status-label"
      className={cn(
        'inline-flex flex-none items-center gap-1.5 text-caption',
        tone === 'done' ? 'text-ink-soft' : 'text-ink-faint',
        className,
      )}
      {...props}
    >
      <Dot tone={tone} size="sm" />
      {children}
    </span>
  )
}

export { StatusLabel }
