import type { ComponentProps } from 'react'
import { useStore } from '../lib/store'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Tooltip } from './ui/tooltip'
import { BookmarkIcon, PanelExpandRightIcon, PulseIcon, SparkIcon } from './ui/icons'

type PanelTab = 'tasks' | 'activity' | 'memory'

/** The collapsed side panel: a column of icon buttons pinned to the top-right
 *  of the canvas while the panel is closed. Each opens the panel on its tab;
 *  the panel takes the rail's place until its ✕ closes it. Counts and alerts
 *  ride on the icons so a closed panel still tells you whether anything is
 *  happening. */
export function SideRail({ onOpen }: { onOpen: () => void }) {
  const setTab = useStore((s) => s.setPanelTab)
  const working = useStore((s) => s.tasks.filter((t) => t.agentName && !t.endedAt && !t.failedAt).length)
  const proposalPending = useStore((s) => s.proposals.some((p) => p.status === 'pending'))

  function show(next: PanelTab) {
    setTab(next)
    onOpen()
  }

  return (
    <nav
      aria-label="Canvas side panel"
      className="absolute top-3 right-3 z-[38] flex w-12 flex-col items-center gap-1.5 rounded-[14px] border border-line bg-surface p-1.5 shadow-card"
    >
      <RailControl label="Expand panel" onClick={onOpen}>
        <PanelExpandRightIcon />
      </RailControl>
      <span aria-hidden className="my-0.5 h-px w-6 bg-line-soft" />
      <RailControl
        label={working ? `Agents · ${working} working` : 'Agents'}
        className={cn(working > 0 && 'bg-brand/6 text-brand')}
        onClick={() => show('tasks')}
      >
        <SparkIcon className="size-4" />
        {working > 0 && (
          <span className="absolute -top-0.5 -right-0.5 grid h-[15px] min-w-[15px] place-items-center rounded-lg border-2 border-surface bg-brand px-[3px] font-mono text-[8px] font-medium text-white">
            {working}
          </span>
        )}
      </RailControl>
      <RailControl label="Activity" onClick={() => show('activity')}>
        <PulseIcon />
      </RailControl>
      <RailControl label={proposalPending ? 'Memory · suggestion to review' : 'Memory'} onClick={() => show('memory')}>
        <BookmarkIcon />
        {proposalPending && (
          <span className="absolute top-[5px] right-[5px] size-1.5 rounded-full bg-accent-ink shadow-[0_0_0_2px_var(--surface)]" />
        )}
      </RailControl>
    </nav>
  )
}

function RailControl({ label, className, ...props }: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip label={label} side="left">
      <Button
        variant="bare"
        size="icon"
        aria-label={label}
        className={cn('relative size-[34px] rounded-lg text-ink-soft hover:bg-paper-deep hover:text-ink', className)}
        {...props}
      />
    </Tooltip>
  )
}
