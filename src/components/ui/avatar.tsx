import * as React from 'react'

import { cn } from '@/lib/utils'
import { AgentIcon, agentBrand } from '../AgentIcon'

function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

/** Presence tile. Agents wear a squarer badge with a pulse ring and, where we
 *  know the brand, its own colours; people get a round initials disc. */
function Avatar({
  name,
  color = 'var(--ink)',
  kind = 'user',
  status,
  owner,
  stacked = false,
  className,
  ...props
}: Omit<React.ComponentProps<'div'>, 'color'> & {
  name: string
  color?: string
  kind?: 'user' | 'agent'
  status?: string
  owner?: string
  /* overlapping row of presences rather than a single standalone avatar */
  stacked?: boolean
}) {
  const brand = kind === 'agent' ? agentBrand(name) : undefined
  const tile = brand?.bg ?? color
  return (
    <div
      data-slot="avatar"
      className={cn(
        'relative grid size-[30px] place-items-center rounded-full border-2 border-surface text-[11px] font-bold',
        stacked && '-ml-[7px] first:ml-0',
        kind === 'agent' &&
          'rounded-[9px] after:absolute after:-inset-[5px] after:animate-[agent-pulse_1.8s_ease-out_infinite] after:rounded-[13px] after:border-2 after:border-current after:opacity-0 after:content-[""]',
        className,
      )}
      style={{ background: tile, color: tile }}
      title={`${name}${kind === 'agent' ? (owner ? ` (${owner}'s agent)` : ' (agent)') : ''}${status ? ` — ${status}` : ''}`}
      {...props}
    >
      <span className={cn('grid place-items-center', kind === 'agent' ? 'text-white' : 'text-paper')}>
        {kind === 'agent' ? <AgentIcon name={name} size={15} color={brand?.fg ?? '#fff'} /> : initialsOf(name)}
      </span>
    </div>
  )
}

export { Avatar }
