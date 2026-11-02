import * as React from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'
import { CheckIcon, ChevronDownIcon } from './icons'

/* Pick one value from a short list: a role, a destination workspace, a day of
   the week. The trigger is a field-height ring control (no border, like every
   other control) and the list opens in the same surface as the dropdown
   menus. Radix keeps the keyboard a native select has (arrows, typeahead,
   Escape) and returns focus to the trigger on close.

   Radix reserves the empty string for "nothing chosen": `value=""` shows the
   placeholder, and no SelectItem may use it. A caller whose "none" is a real
   choice maps it to a sentinel of its own. */

const Select = SelectPrimitive.Root
const SelectGroup = SelectPrimitive.Group

function SelectValue(props: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

const selectTriggerVariants = cva(
  'flex min-w-0 cursor-pointer items-center justify-between gap-2 rounded-control bg-surface pl-[11px] pr-2.5 text-left font-medium text-ink shadow-ring transition-shadow outline-none select-none hover:shadow-ring-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-60 data-[placeholder]:font-normal data-[placeholder]:text-ink-faint *:data-[slot=select-value]:truncate',
  {
    variants: {
      size: {
        sm: 'h-8 text-body',
        md: 'h-9 text-copy',
      },
    },
    defaultVariants: { size: 'md' },
  },
)

function SelectTrigger({
  className,
  size,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & VariantProps<typeof selectTriggerVariants>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size ?? 'md'}
      className={cn(selectTriggerVariants({ size, className }))}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon width={12} height={12} className="flex-none text-ink-faint" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

/* Radix hides the list's scrollbar; these arrows are the affordance a long
   list (every half hour of the day) shows instead. */
const scrollButtonClass = 'flex h-6 flex-none cursor-default items-center justify-center bg-surface text-ink-faint'

function SelectContent({
  className,
  children,
  position = 'popper',
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        sideOffset={position === 'popper' ? sideOffset : undefined}
        collisionPadding={12}
        className={cn(
          'relative z-[70] max-h-[min(320px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-card bg-surface shadow-pop',
          'animate-[chip-in_0.18s_ease] data-[state=closed]:animate-none',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className={scrollButtonClass}>
          <ChevronDownIcon width={12} height={12} className="rotate-180" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="p-1.5">{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className={scrollButtonClass}>
          <ChevronDownIcon width={12} height={12} />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'relative flex w-full cursor-pointer items-center gap-2.5 rounded-control py-2 pl-2.5 pr-8 text-body text-ink outline-none select-none data-[disabled]:pointer-events-none data-[highlighted]:bg-sub data-[disabled]:text-ink-faint',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2.5 flex text-ink">
        <CheckIcon width={14} height={14} />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn('my-0.5 h-px bg-line-soft', className)}
      {...props}
    />
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  selectTriggerVariants,
}
