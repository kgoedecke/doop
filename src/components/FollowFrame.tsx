import { useStore } from '../lib/store'
import { AgentIcon } from './AgentIcon'

/** Figma-style "you are following X": a border in the leader's colour around
 *  the stage and a pill naming them. Any pan or zoom of our own lets go, so
 *  the pill's × is for people who want to stop without moving. */
export function FollowFrame() {
  const leader = useStore((s) => (s.following ? s.presences[s.following] : undefined))
  const stop = useStore((s) => s.setFollowing)
  if (!leader) return null
  return (
    <div
      className="pointer-events-none absolute inset-0 z-[34] animate-[chip-in_0.2s_ease] rounded-[3px] border-[3px]"
      style={{ borderColor: leader.color }}
    >
      <div
        className="pointer-events-auto absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-full py-1.5 pr-2 pl-3.5 text-[12.5px] font-bold text-white shadow-pop"
        style={{ background: leader.color }}
      >
        <span>
          Following{' '}
          {leader.kind === 'agent' && (
            <>
              <AgentIcon name={leader.name} size={11} color="#fff" />{' '}
            </>
          )}
          {leader.name}
        </span>
        <button
          type="button"
          className="grid size-[18px] place-items-center rounded-full bg-white/25 text-[12px] leading-none hover:bg-white/40"
          aria-label={`Stop following ${leader.name}`}
          title="Stop following (Esc)"
          onClick={() => stop(null)}
        >
          ×
        </button>
      </div>
    </div>
  )
}
