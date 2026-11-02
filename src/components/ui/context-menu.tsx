import * as React from 'react'
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu'

import { cn } from '@/lib/utils'
import { menuItemVariants } from './menu'
import type { VariantProps } from 'class-variance-authority'

/* Right-click menus on Radix: it owns the pointer anchor, the collision
   flipping, focus (the menu takes it on open and hands it back on close),
   arrow-key roving and typeahead — all of which the hand-rolled portal this
   replaces did not have. The look comes from the same recipes as `Menu`, so
   the canvas menus and the account menu stay one design.

   Content is portalled to the body, so it positions in screen coordinates and
   the zoomed `.world` transform underneath never scales it. */

const ContextMenu = ContextMenuPrimitive.Root
const ContextMenuTrigger = ContextMenuPrimitive.Trigger

function ContextMenuContent({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        collisionPadding={8}
        className={cn(
          'z-[70] min-w-[190px] rounded-[12px] bg-surface p-1.5 shadow-pop',
          'animate-[chip-in_0.18s_ease] data-[state=closed]:animate-none',
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuItem({
  className,
  tone,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & VariantProps<typeof menuItemVariants>) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      className={cn(
        menuItemVariants({ tone }),
        /* Radix drives hover AND keyboard focus through data-highlighted, so
           the two states cannot drift apart */
        'cursor-pointer outline-none data-[highlighted]:bg-sub data-[disabled]:pointer-events-none data-[disabled]:text-ink-faint',
        tone === 'danger' && 'data-[highlighted]:bg-accent-ink/10',
        className,
      )}
      {...props}
    />
  )
}

function ContextMenuSeparator({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn('my-[5px] h-px bg-line-soft', className)}
      {...props}
    />
  )
}

export { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator }
