import * as React from 'react'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import type { VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'
import { CheckIcon } from './icons'
import { menuItemVariants } from './menu'

/* A menu hanging off a button. Radix handles what the hand-rolled version
   could not: focus moves into the menu on open and back to the trigger on
   close, arrow keys and typeahead work, and the content flips and shifts to
   stay on screen instead of being pinned with fixed offsets that only looked
   right on a wide window. Styling matches the canvas context menus. */

const DropdownMenu = DropdownMenuPrimitive.Root
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger

function DropdownMenuContent({
  className,
  sideOffset = 8,
  align = 'end',
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        align={align}
        collisionPadding={12}
        className={cn(
          'z-[70] w-[min(340px,calc(100vw-24px))] rounded-[14px] border border-line bg-surface p-1.5 shadow-pop',
          'animate-[chip-in_0.18s_ease] data-[state=closed]:animate-none',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

/* what every row in the menu shares, whichever primitive renders it */
const itemClass =
  'cursor-pointer gap-[11px] rounded-[9px] px-2.5 py-[9px] text-[13.5px] outline-none data-[highlighted]:bg-paper-deep data-[disabled]:pointer-events-none data-[disabled]:text-ink-faint'

function DropdownMenuItem({
  className,
  tone,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & VariantProps<typeof menuItemVariants>) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(
        menuItemVariants({ tone }),
        itemClass,
        tone === 'danger' && 'data-[highlighted]:bg-accent-ink/10',
        className,
      )}
      {...props}
    />
  )
}

const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup

/** One of a set where exactly one is on; the chosen row wears a check. */
function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(menuItemVariants(), itemClass, className)}
      {...props}
    >
      {children}
      <DropdownMenuPrimitive.ItemIndicator className="ml-auto flex text-ink">
        <CheckIcon width={14} height={14} aria-hidden />
      </DropdownMenuPrimitive.ItemIndicator>
    </DropdownMenuPrimitive.RadioItem>
  )
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn('my-0.5 h-px bg-line-soft', className)}
      {...props}
    />
  )
}

/** Non-interactive block at the top of a menu (the signed-in identity). */
function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return <DropdownMenuPrimitive.Label data-slot="dropdown-menu-label" className={cn(className)} {...props} />
}

/** Uppercase caption over a group of rows further down the menu. */
function DropdownMenuCaption({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-caption"
      className={cn('px-2.5 pb-1 pt-[7px] text-[10px] font-bold uppercase tracking-[0.12em] text-ink-faint', className)}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuCaption,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
}
