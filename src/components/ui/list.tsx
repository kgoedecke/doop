import * as React from 'react'

import { cn } from '@/lib/utils'

/* The stacked rows panels are built from: a caption, an optional explanatory
   line, then rows that are usually buttons. Kept dumb — callers decide what
   goes in the title and meta slots. */
function ListSection({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="list-section"
      className={cn(
        'flex items-center justify-between gap-2 px-4 pb-1.5 pt-3 text-caption/3.5 font-extrabold uppercase tracking-[0.08em] text-ink-faint',
        className,
      )}
      {...props}
    />
  )
}

/** The explanatory line an empty section shows instead of rows. */
function ListHint({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="list-hint"
      className={cn('border-b border-line-soft px-4 pb-3 pt-0.5 text-xs leading-[1.5] text-ink-faint', className)}
      {...props}
    />
  )
}

function ListRow({ className, ...props }: React.ComponentProps<'button'>) {
  return (
    <button
      type="button"
      data-slot="list-row"
      className={cn(
        'flex w-full flex-col gap-[3px] border-b border-line-soft px-4 py-[11px] text-left text-ink transition-colors hover:bg-paper',
        className,
      )}
      {...props}
    />
  )
}

/** A row that is not interactive (decisions, read-only history). */
function ListItem({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="list-item"
      className={cn('flex flex-col gap-[3px] border-b border-line-soft px-4 py-[9px]', className)}
      {...props}
    />
  )
}

function ListTitle({ className, ...props }: React.ComponentProps<'span'>) {
  return <span data-slot="list-title" className={cn('text-body/4 font-bold', className)} {...props} />
}

function ListSummary({ className, ...props }: React.ComponentProps<'span'>) {
  return <span data-slot="list-summary" className={cn('truncate text-xs text-ink-soft', className)} {...props} />
}

function ListMeta({ className, ...props }: React.ComponentProps<'span'>) {
  return <span data-slot="list-meta" className={cn('text-caption/3.5 text-ink-faint', className)} {...props} />
}

export interface PersonRowProps extends Omit<React.ComponentProps<'span'>, 'children'> {
  /** the face, usually an `Avatar` (28–32px); any disc of the same size fits */
  avatar: React.ReactNode
  name: React.ReactNode
  /** the line under the name: an email, a member count, when they joined */
  detail?: React.ReactNode
  /** the right-hand end: a role, a badge, a remove action */
  trailing?: React.ReactNode
}

/** One person on a line: face, name over a secondary line, and whatever sits
 *  at the end. The share list, the members table and the account menu.
 *  A span all the way down, so it nests inside a `CardRow` or a label. */
function PersonRow({ avatar, name, detail, trailing, className, ...props }: PersonRowProps) {
  return (
    <span data-slot="person-row" className={cn('flex min-w-0 items-center gap-2.5', className)} {...props}>
      {avatar}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body font-medium text-ink">{name}</span>
        {detail ? <span className="truncate text-label font-normal text-ink-faint">{detail}</span> : null}
      </span>
      {trailing ? <span className="flex flex-none items-center gap-2.5">{trailing}</span> : null}
    </span>
  )
}

export { ListSection, ListHint, ListRow, ListItem, ListTitle, ListSummary, ListMeta, PersonRow }
