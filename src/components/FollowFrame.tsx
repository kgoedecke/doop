import { useStore } from '../lib/store'
import { agentFollowFrame, followedAgent, followedLeader } from '../lib/follow'
import { AgentIcon } from './AgentIcon'
import { XIcon } from './ui/icons'
import { useT } from '../lib/i18n'

/** Figma-style "you are following X": a border in the leader's colour around
 *  the stage and a pill naming them (a followed agent while it is idle too). Any pan or zoom of our own lets go, so
 *  the pill's × is for people who want to stop without moving. The pill hangs
 *  below the top bar (--chrome-top, set by the page), where the presence
 *  avatars would otherwise cover it; the 7px plus the 3px border lines it up
 *  with the tool rail. */
export function FollowFrame() {
  const t = useT()
  const leader = useStore(followedLeader)
  /* a followed agent that is idle (out of the roster) or has no frame to show yet */
  const waiting = useStore((s) => {
    const agent = followedAgent(s)
    return !!agent && (!s.presences[agent.clientId] || !agentFollowFrame(s))
  })
  const stop = useStore((s) => s.setFollowing)
  if (!leader) return null
  return (
    <div
      className="pointer-events-none absolute inset-0 z-[34] animate-[chip-in_0.2s_ease] rounded-[3px] border-[3px]"
      style={{ borderColor: leader.color }}
    >
      <div
        className="pointer-events-auto absolute left-1/2 top-[calc(var(--chrome-top,0px)+7px)] flex -translate-x-1/2 items-center gap-2 rounded-full py-1.5 pr-2 pl-3.5 text-[12.5px] font-medium text-white shadow-pop"
        style={{ background: leader.color }}
      >
        <span>
          {t('canvas.following')}{' '}
          {leader.kind === 'agent' && (
            <>
              <AgentIcon name={leader.name} brand={leader.brand} size={11} color="#fff" />{' '}
            </>
          )}
          {leader.name}
          {waiting && <span className="font-normal opacity-80"> · {t('canvas.followIdle')}</span>}
        </span>
        <button
          type="button"
          className="grid size-[18px] place-items-center rounded-full bg-white/25 hover:bg-white/40"
          aria-label={t('canvas.stopFollowing', { name: leader.name })}
          title={t('canvas.stopFollowingEsc')}
          onClick={() => stop(null)}
        >
          <XIcon size={11} />
        </button>
      </div>
    </div>
  )
}
