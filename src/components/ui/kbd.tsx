import * as React from 'react'

import { cn } from '@/lib/utils'

/** A key cap: 20px tall, the key in mono micro type, edged by an inset
 *  hairline rather than a border so it sits flush in a 30px field. Shortcut
 *  hints in search fields, menus and tooltips. */
function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'inline-flex h-5 min-w-5 flex-none items-center justify-center rounded-[5px] px-[5px] font-mono text-micro leading-none text-ink-faint shadow-[inset_0_0_0_1px_var(--line)]',
        className,
      )}
      {...props}
    />
  )
}

export { Kbd }
