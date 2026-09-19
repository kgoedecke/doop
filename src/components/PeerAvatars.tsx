import type { Presence } from '../../shared/types'
import { useStore } from '../lib/store'
import { locatePresence } from '../lib/locate'
import { Avatar } from './ui/avatar'
import { cn } from '@/lib/utils'

/** The other people and agents on the canvas. A person's avatar is a toggle:
 *  click to follow their camera around, click again to let go. An agent's
 *  avatar jumps the camera to the frame it is working on. */
export function PeerAvatars({ others }: { others: Presence[] }) {
  return (
    <>
      {others.map((p) =>
        p.kind === 'user' ? (
          <FollowAvatar key={p.clientId} presence={p} />
        ) : (
          <JumpAvatar key={p.clientId} presence={p} />
        ),
      )}
    </>
  )
}

const clickable =
  '-ml-[7px] rounded-full transition-transform first:ml-0 hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-faint'

function FollowAvatar({ presence: p }: { presence: Presence }) {
  const followed = useStore((s) => s.following === p.clientId)
  const setFollowing = useStore((s) => s.setFollowing)
  return (
    <button
      type="button"
      /* lifted so the next avatar in the stack does not paint over the halo */
      className={cn(clickable, followed && 'relative z-10')}
      aria-pressed={followed}
      title={followed ? `Stop following ${p.name}` : `Follow ${p.name} around the canvas`}
      onClick={() => setFollowing(followed ? null : p.clientId)}
    >
      <Avatar
        name={p.name}
        color={p.color}
        kind={p.kind}
        status={p.status}
        owner={p.owner}
        /* a halo in their colour marks who we are following */
        style={followed ? { boxShadow: `0 0 0 2px var(--surface), 0 0 0 4px ${p.color}` } : undefined}
      />
    </button>
  )
}

function JumpAvatar({ presence: p }: { presence: Presence }) {
  const locatable = useStore((s) => locatePresence(p, s) !== undefined)
  if (!locatable) {
    return <Avatar name={p.name} color={p.color} kind={p.kind} status={p.status} owner={p.owner} stacked />
  }
  const label = `${p.name}${p.owner ? ` (${p.owner}'s agent)` : ' (agent)'}${p.status ? ` — ${p.status}` : ''}`
  return (
    <button
      type="button"
      className={clickable}
      title={`${label} — click to go where it is working`}
      onClick={() => {
        const s = useStore.getState()
        const at = locatePresence(p, s)
        if (!at) return
        if ('frameId' in at) s.requestFlyTo(at.frameId)
        else s.requestFlyToPoint(at.point.x, at.point.y)
      }}
    >
      <Avatar name={p.name} color={p.color} kind={p.kind} status={p.status} owner={p.owner} />
    </button>
  )
}
