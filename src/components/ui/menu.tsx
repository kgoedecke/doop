import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from '@radix-ui/react-slot'

import { cn } from '@/lib/utils'

/* The floating menu surface used by the canvas context menus and the small
   popovers hanging off toolbar buttons. Items style themselves — nothing here
   reaches into its children, so a caller can mix buttons and links freely. */
const MenuSurface = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(function MenuSurface(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-slot="menu-surface"
      role="menu"
      className={cn(
        'min-w-[190px] rounded-[12px] bg-surface p-1.5 shadow-ring animate-[chip-in_0.18s_ease]',
        className,
      )}
      {...props}
    />
  )
})

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

const MenuItem = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<'button'> & VariantProps<typeof menuItemVariants> & { asChild?: boolean }
>(function MenuItem({ className, tone, asChild = false, ...props }, ref) {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp
      ref={ref}
      data-slot="menu-item"
      role="menuitem"
      className={cn(menuItemVariants({ tone, className }))}
      {...props}
    />
  )
})

/** Trailing keyboard shortcut inside a menu item. */
function MenuHint({ className, ...props }: React.ComponentProps<'span'>) {
  return <span data-slot="menu-hint" className={cn('ml-auto pl-3 text-[11px] text-ink-faint', className)} {...props} />
}

function MenuSeparator({ className, ...props }: React.ComponentProps<'hr'>) {
  return (
    <hr
      data-slot="menu-separator"
      className={cn('my-[5px] border-0 border-t border-line-soft', className)}
      {...props}
    />
  )
}

/** Uppercase caption above a group of items. */
function MenuLabel({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="menu-label"
      className={cn('px-2.5 pb-1 pt-1.5 text-[11px] font-normal text-ink-faint', className)}
      {...props}
    />
  )
}

export { MenuSurface, MenuItem, MenuHint, MenuSeparator, MenuLabel, menuItemVariants }
