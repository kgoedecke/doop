import * as React from 'react'

import { cn } from '@/lib/utils'
import { Logo } from '../Logo'

/** Logo + "Doop", the lockup used in headers, the auth card and the footer. */
function Wordmark({
  size = 'md',
  className,
  children = 'Doop',
  ...props
}: React.ComponentProps<'span'> & { size?: 'sm' | 'md' }) {
  return (
    <span
      data-slot="wordmark"
      className={cn(
        'flex items-center gap-3 font-display font-extrabold tracking-[-0.01em]',
        size === 'sm' ? 'gap-2 text-lead/4.5' : 'text-heading/5.5',
        className,
      )}
      {...props}
    >
      <Logo className={size === 'sm' ? 'size-[26px]' : 'size-[30px]'} />
      {children}
    </span>
  )
}

export { Wordmark }
