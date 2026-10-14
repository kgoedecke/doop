import { canvasPages } from '../../shared/pages'
import { useStore } from '../lib/store'
import { AgentIcon } from './AgentIcon'

/**
 * Placeholder artboards for agents that claimed a card but have not touched a
 * frame yet. The research/thinking phase of a run used to look like nothing
 * happening on the canvas even though the task panel showed a claim — a ghost
 * frame at the server's auto-placement spot shows where the work will land and
 * carries the agent's live status. Purely presentational: nothing persists,
 * and the ghost yields the moment the agent touches a real frame.
 */
export function GhostFrames() {
  const canvas = useStore((s) => s.canvas)
  const activePageId = useStore((s) => s.activePageId)
  const presences = useStore((s) => s.presences)
  const tasks = useStore((s) => s.tasks)
  if (!canvas || activePageId !== canvasPages(canvas)[0]!.id) return null
  const working = Object.values(presences).filter(
    (p) =>
      p.kind === 'agent' &&
      p.status &&
      !p.activeFrameId &&
      tasks.some((t) => t.queuedBy && t.agentName === p.name && !t.endedAt && !t.failedAt),
  )
  if (working.length === 0) return null
  /* mirror store.createFrame's auto-placement: right of the right-most frame */
  const rightmost = canvas.frames.reduce((mx, f) => Math.max(mx, f.x + f.width), 0)
  const baseX = canvas.frames.length ? rightmost + 80 : 120
  return (
    <>
      {working.map((p, i) => (
        <div
          key={p.clientId}
          className="pointer-events-none absolute rounded-[2px] bg-[color-mix(in_srgb,var(--ghost-color,var(--ink-faint))_4%,transparent)] outline-offset-[-1.5px] [outline:1.5px_dashed_color-mix(in_srgb,var(--ghost-color,var(--ink-faint))_55%,transparent)]"
          style={
            {
              left: baseX + i * 720,
              top: 120,
              width: 640,
              height: 480,
              '--ghost-color': p.color,
            } as React.CSSProperties
          }
        >
          {/* the label counter-scales against the viewport zoom, like .frame-label */}
          <div className="absolute inset-x-0 -top-[26px] flex cursor-default select-none items-center gap-2 origin-bottom-left whitespace-nowrap text-[12px] font-semibold [color:color-mix(in_srgb,var(--ghost-color,var(--ink-soft))_80%,var(--ink-soft))] [transform:scale(min(calc(1/var(--zoom,1)),2.4))]">
            <AgentIcon name={p.name} size={13} color={p.color} />
            <span className="overflow-hidden text-ellipsis">{p.name} is on it</span>
          </div>
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-[18px] p-8">
            <div className="flex w-[min(60%,280px)] flex-col gap-2.5">
              <span className="h-2.5 w-[55%] animate-[ghost-pulse_1.6s_ease-in-out_infinite] rounded-[5px] bg-[color-mix(in_srgb,var(--ghost-color,var(--ink-faint))_18%,transparent)]" />
              <span className="h-2.5 w-full animate-[ghost-pulse_1.6s_ease-in-out_infinite] rounded-[5px] bg-[color-mix(in_srgb,var(--ghost-color,var(--ink-faint))_18%,transparent)] [animation-delay:0.2s]" />
              <span className="h-2.5 w-[78%] animate-[ghost-pulse_1.6s_ease-in-out_infinite] rounded-[5px] bg-[color-mix(in_srgb,var(--ghost-color,var(--ink-faint))_18%,transparent)] [animation-delay:0.4s]" />
            </div>
            <div className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[14px] text-ink-soft">
              {p.status}
            </div>
          </div>
        </div>
      ))}
    </>
  )
}
