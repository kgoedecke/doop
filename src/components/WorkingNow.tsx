import { useStore } from '../lib/store'
import { AgentIcon } from './AgentIcon'
import { cn } from '@/lib/utils'

/** Floating strip of live "what I'm working on" statuses (agents post via set_status). */
export function WorkingNow() {
  const working = useStore((s) => Object.values(s.presences).filter((p) => p.status))
  const layersOpen = useStore((s) => s.layersOpen)
  if (working.length === 0) return null
  return (
    <div
      className={cn(
        'pointer-events-none absolute bottom-4 left-4 z-30 flex max-w-[min(420px,60vw)] flex-col gap-1.5 max-md:right-2 max-md:bottom-[calc(132px+env(safe-area-inset-bottom))] max-md:left-2 max-md:max-w-none',
        /* clear of the 300px Layers rail at left: 12px */
        layersOpen && 'md:left-[324px]',
      )}
    >
      {working.map((p) => (
        <div
          key={p.clientId}
          className="pointer-events-auto flex min-w-0 animate-[chip-in_0.2s_ease] items-center gap-2 rounded-full border border-line bg-surface py-1.5 pr-3.5 pl-2.5 text-[12.5px] shadow-card"
          title={`${p.name}${p.owner ? ` (${p.owner}'s agent)` : ''}: ${p.status}`}
        >
          <span
            className="size-[7px] flex-none animate-[status-pulse_1.6s_ease-in-out_infinite] rounded-full"
            style={{ background: p.color }}
          />
          <span className="flex-none font-bold" style={{ color: p.color }}>
            {p.kind === 'agent' && <AgentIcon name={p.name} size={12} />} {p.name}
          </span>
          <span className="truncate text-ink-soft">{p.status}</span>
        </div>
      ))}
    </div>
  )
}
