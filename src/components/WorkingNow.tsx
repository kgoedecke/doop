import { useMemo, type CSSProperties } from 'react'
import { useStore } from '../lib/store'
import { AgentIcon } from './AgentIcon'
import { cn } from '@/lib/utils'
import { useT } from '../lib/i18n'

/** Floating stack of live "what I'm working on" statuses (agents post via
 *  set_status): one small white pill each, at the top-left of the open
 *  canvas, beside the tool rail. */
export function WorkingNow({ style, className }: { style?: CSSProperties; className?: string }) {
  /* select the stable records and derive here: a selector returning a fresh
     array would re-render this on every store tick, pans included */
  const t = useT()
  const presences = useStore((s) => s.presences)
  const streams = useStore((s) => s.streams)
  const working = useMemo(() => Object.values(presences).filter((p) => p.status), [presences])
  const streaming = useMemo(() => new Set(Object.values(streams).map((s) => s.name)), [streams])
  if (working.length === 0) return null
  return (
    <div
      className={cn(
        'pointer-events-none absolute top-3.5 z-30 flex max-w-[min(420px,50vw)] flex-col items-start gap-1.5 transition-[left] duration-150 max-md:top-auto max-md:right-2 max-md:bottom-[calc(66px+env(safe-area-inset-bottom))] max-md:left-2! max-md:max-w-none',
        className,
      )}
      style={style}
    >
      {working.map((p) => (
        <div
          key={p.clientId}
          className="pointer-events-auto flex h-7 max-w-full min-w-0 animate-[chip-in_0.2s_ease] items-center gap-2 rounded-[8px] bg-surface pr-2.5 pl-2 text-[12px] text-ink-soft shadow-ring"
          title={`${p.name}${p.owner ? ` (${t('canvas.agentOf', { owner: p.owner })})` : ''}: ${p.status}`}
        >
          {p.kind === 'agent' ? (
            <span className="grid size-[13px] flex-none place-items-center">
              <AgentIcon name={p.name} size={13} />
            </span>
          ) : (
            <span className="size-2 flex-none rounded-full" style={{ background: p.color }} />
          )}
          <b className="flex-none font-medium text-ink">{p.name}</b>
          <span className="truncate">{p.status}</span>
          {streaming.has(p.name) && (
            <span className="size-1.5 flex-none animate-[status-pulse_1.6s_ease-in-out_infinite] rounded-full bg-success" />
          )}
        </div>
      ))}
    </div>
  )
}
