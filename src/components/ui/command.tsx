import * as React from 'react'
import { Command as CommandPrimitive } from 'cmdk'

import { cn } from '@/lib/utils'
import { SearchIcon } from './icons'

/* The command list behind the ⌘K palette: cmdk does the fuzzy filtering,
   the highlight that follows the arrow keys and Enter; these parts dress it
   in the palette's look (the search modal's 48px bar, rows the menus' size,
   captions over groups). */

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive data-slot="command" className={cn('flex flex-col text-ink outline-none', className)} {...props} />
  )
}

/** The palette's top line: a glyph and a bare field, closed by a hairline. */
function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div
      data-slot="command-input"
      className="flex h-12 items-center gap-2.5 border-b border-line-soft px-4 text-ink-faint"
    >
      <SearchIcon width={15} height={15} aria-hidden />
      <CommandPrimitive.Input
        className={cn(
          'h-full min-w-0 flex-1 bg-transparent text-copy text-ink outline-none placeholder:text-ink-ghost',
          className,
        )}
        {...props}
      />
    </div>
  )
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn('max-h-[min(60vh,420px)] scroll-py-2 overflow-y-auto p-1.5', className)}
      {...props}
    />
  )
}

function CommandEmpty({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn('px-3 py-6 text-center text-body text-ink-faint', className)}
      {...props}
    />
  )
}

/** Rows under a caption ("Arrange"). */
function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:text-ink-faint',
        className,
      )}
      {...props}
    />
  )
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        'flex cursor-pointer items-center gap-2.5 rounded-row px-2.5 py-2 text-body outline-none select-none data-[selected=true]:bg-paper-deep data-[disabled=true]:pointer-events-none data-[disabled=true]:text-ink-faint',
        className,
      )}
      {...props}
    />
  )
}

/** The chord at a row's end, in mono caption type. */
function CommandShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn('ml-auto flex-none font-mono text-caption text-ink-faint', className)}
      {...props}
    />
  )
}

export { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandShortcut }
