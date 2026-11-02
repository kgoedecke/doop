import * as React from 'react'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { cva, type VariantProps } from 'class-variance-authority'

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

/* Three menu widths: sm for a short list of verbs (sort, row actions), md for
   rows with a hint or a sub-line, lg for rows carrying a name and an email or
   a model blurb. Left unset, the menu sizes to the 340px reading width. Each
   still gives way to a phone's width. */
const dropdownMenuContentVariants = cva(
  /* never taller than the room Radix measured beside the trigger: a long menu
     (the model list, with its wrapping blurbs) scrolls instead of running off a
     short window */
  'z-[70] max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto rounded-[12px] bg-surface p-1.5 shadow-pop animate-[chip-in_0.18s_ease] data-[state=closed]:animate-none',
  {
    variants: {
      width: {
        auto: 'w-[min(340px,calc(100vw-24px))]',
        sm: 'w-[min(160px,calc(100vw-24px))]',
        md: 'w-[min(220px,calc(100vw-24px))]',
        lg: 'w-[min(260px,calc(100vw-24px))]',
      },
    },
    defaultVariants: { width: 'auto' },
  },
)

function DropdownMenuContent({
  className,
  sideOffset = 8,
  align = 'end',
  width,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content> & VariantProps<typeof dropdownMenuContentVariants>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        align={align}
        collisionPadding={12}
        className={cn(dropdownMenuContentVariants({ width }), className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

/* what every row in the menu shares, whichever primitive renders it */
const itemClass =
  'cursor-pointer gap-2.5 rounded-[8px] px-2.5 py-2 text-[12.5px] outline-none data-[highlighted]:bg-sub data-[disabled]:pointer-events-none data-[disabled]:text-ink-faint'

/** The line under a row's label ("2 takes, side by side"). Children become the label. */
type ItemDescription = {
  /** a sub-line under the label, in caption type; it wraps rather than hiding words */
  description?: React.ReactNode
}

function ItemText({ children, description }: { children: React.ReactNode; description: React.ReactNode }) {
  return (
    <span data-slot="dropdown-menu-item-text" className="flex min-w-0 flex-1 flex-col">
      <span className="truncate">{children}</span>
      <span data-slot="dropdown-menu-item-description" className="text-caption text-ink-faint">
        {description}
      </span>
    </span>
  )
}

function DropdownMenuItem({
  className,
  tone,
  description,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & VariantProps<typeof menuItemVariants> & ItemDescription) {
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
    >
      {description === undefined ? children : <ItemText description={description}>{children}</ItemText>}
    </DropdownMenuPrimitive.Item>
  )
}

const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup

/** One of a set where exactly one is on; the chosen row wears a check. */
function DropdownMenuRadioItem({
  className,
  children,
  description,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem> & ItemDescription) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(menuItemVariants(), itemClass, className)}
      {...props}
    >
      {description === undefined ? children : <ItemText description={description}>{children}</ItemText>}
      <DropdownMenuPrimitive.ItemIndicator className="ml-auto flex flex-none text-ink">
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

/** Caption over a group of rows further down the menu. */
function DropdownMenuCaption({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-caption"
      className={cn('px-2.5 pb-1 pt-[7px] text-caption text-ink-faint', className)}
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
