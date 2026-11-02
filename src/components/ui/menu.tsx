import * as React from 'react'
import { cva } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/* The row style the dropdown and context menus share. */
const menuItemVariants = cva(
  'flex w-full items-center gap-2 rounded-[8px] border-0 bg-transparent px-2.5 py-[7px] text-left text-[12.5px] font-normal leading-normal no-underline transition-colors disabled:cursor-default disabled:text-ink-faint disabled:hover:bg-transparent',
  {
    variants: {
      tone: {
        default: 'text-ink hover:bg-sub',
        danger: 'text-accent-ink hover:bg-accent-ink/10',
      },
    },
    defaultVariants: { tone: 'default' },
  },
)

/** Trailing keyboard shortcut inside a menu item. */
function MenuHint({ className, ...props }: React.ComponentProps<'span'>) {
  return <span data-slot="menu-hint" className={cn('ml-auto pl-3 text-[11px] text-ink-faint', className)} {...props} />
}

export { MenuHint, menuItemVariants }
