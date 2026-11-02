import * as React from 'react'

import { cn } from '@/lib/utils'
import { Card } from './card'

/* What a page shows before it has anything: a title, a line of why, and the
   one action that changes that. `card` is the hero card on the home list and
   the gallery; `dashed` is the centred placeholder with an illustration row
   (the automations chain) on a page whose content is a table. */
const VARIANTS = {
  card: {
    card: 'max-w-[560px] px-5 pb-6 pt-5 sm:px-7 sm:pb-7 sm:pt-[26px]',
    title: 'font-display text-heading font-extrabold tracking-[-0.02em]',
    description: 'mb-[18px] mt-2.5 text-sm leading-[1.6] text-ink-soft',
    action: '',
  },
  dashed: {
    card: 'flex flex-col items-center gap-2.5 px-6 py-[34px] text-center',
    title: 'text-heading font-semibold tracking-[-0.015em]',
    description: 'max-w-[420px] text-copy leading-[1.5] text-ink-soft',
    action: 'mt-2.5',
  },
} as const

function EmptyState({
  variant = 'card',
  illustration,
  title,
  description,
  action,
  className,
  ...props
}: Omit<React.ComponentProps<'div'>, 'title'> & {
  variant?: keyof typeof VARIANTS
  /** marks or tiles above the title, laid out in a row */
  illustration?: React.ReactNode
  title: React.ReactNode
  description: React.ReactNode
  /** the one button */
  action?: React.ReactNode
}) {
  const v = VARIANTS[variant]
  return (
    <Card
      data-slot="empty-state"
      tone={variant === 'dashed' ? 'dashed' : 'default'}
      shape="hero"
      className={cn(v.card, className)}
      {...props}
    >
      {illustration ? <div className="mb-2.5 flex items-center gap-2.5">{illustration}</div> : null}
      <h3 className={v.title}>{title}</h3>
      <p className={v.description}>{description}</p>
      {action ? <div className={v.action}>{action}</div> : null}
    </Card>
  )
}

export { EmptyState }
