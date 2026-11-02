import * as React from 'react'

import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { Button } from './button'

export interface SelectionBarProps extends Omit<React.ComponentProps<'div'>, 'children'> {
  count: number
  total: number
  /** appended to the count, e.g. " — 25 at most" */
  note?: React.ReactNode
  /** `error` reddens the count, for a selection over its limit */
  tone?: 'default' | 'error'
  /** the bar's text actions, usually `SelectionBarAction`s (Select all, Clear) */
  actions?: React.ReactNode
}

/** The "N of M selected" line over a checklist, with its Select all / Clear
 *  actions on the right. The import reviews and the export checklist share it. */
function SelectionBar({ count, total, note, tone = 'default', actions, className, ...props }: SelectionBarProps) {
  const t = useT()
  return (
    <div
      data-slot="selection-bar"
      className={cn('flex items-center justify-between gap-3 px-0.5 pb-[9px]', className)}
      {...props}
    >
      <span className={cn('text-label font-medium', tone === 'error' ? 'text-accent-ink' : 'text-ink-soft')}>
        {t('ui.selectedOf', { count, total })}
        {note}
      </span>
      {actions ? <span className="flex gap-3">{actions}</span> : null}
    </div>
  )
}

/** A selection bar's text action: mono micro type, no chrome, red on hover. */
function SelectionBarAction({ className, ...props }: Omit<React.ComponentProps<typeof Button>, 'variant' | 'size'>) {
  return (
    <Button
      variant="bare"
      size="sm"
      className={cn('p-0 font-mono text-micro hover:bg-transparent hover:text-accent-ink', className)}
      {...props}
    />
  )
}

export { SelectionBar, SelectionBarAction }
