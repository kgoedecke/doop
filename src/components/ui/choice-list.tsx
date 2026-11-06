import * as React from 'react'

import { cn } from '@/lib/utils'
import { ChevronRightIcon } from './icons'
import { Pressable } from './pressable'

/* A short list of things to go to, one per row, laid out the way Settings →
   Doop Agent lists its connections: one ringed panel, hairlines between the
   rows, each row an app icon, a name with a line under it, and a chevron.
   The import picker lists its sources with it and a frame's export its
   formats. */
function ChoiceList({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      role="list"
      data-slot="choice-list"
      className={cn('overflow-hidden rounded-panel bg-surface shadow-ring', className)}
      {...props}
    />
  )
}

interface ChoiceRowProps extends Omit<React.ComponentProps<'button'>, 'title'> {
  /** the row's app icon (an `AppIcon`, 32px) */
  icon: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  /** what sits at the right edge; a chevron unless given */
  trailing?: React.ReactNode
}

function ChoiceRow({ icon, title, description, trailing, disabled, className, ...props }: ChoiceRowProps) {
  return (
    <div role="listitem" className="border-b border-line-soft last:border-b-0">
      <Pressable
        data-slot="choice-row"
        disabled={disabled}
        className={cn(
          'group flex items-center gap-3.5 px-4 py-3 transition-colors',
          disabled ? 'cursor-default' : 'hover:bg-sub',
          className,
        )}
        {...props}
      >
        <span className={cn('flex-none', disabled && 'opacity-55')}>{icon}</span>
        <span className={cn('min-w-0 flex-1', disabled && 'opacity-60')}>
          <span className="block truncate text-copy font-medium text-ink">{title}</span>
          {description && <span className="block text-label text-ink-faint">{description}</span>}
        </span>
        <span className="flex-none text-ink-faint transition-[color,translate] group-hover:translate-x-0.5 group-hover:text-ink group-disabled:translate-x-0 group-disabled:text-ink-faint">
          {trailing ?? <ChevronRightIcon size="rail" />}
        </span>
      </Pressable>
    </div>
  )
}

export { ChoiceList, ChoiceRow }
