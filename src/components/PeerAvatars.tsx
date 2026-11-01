import type { CSSProperties } from 'react'
import type { Presence } from '../../shared/types'
import { useStore } from '../lib/store'
import { locatePresence } from '../lib/locate'
import { Avatar } from './ui/avatar'
import { cn } from '@/lib/utils'
import { useT, type Translate } from '../lib/i18n'

/** True for an agent that is working right now — it posted a status. */
export function isActiveAgent(p: Presence): boolean {
  return p.kind === 'agent' && !!p.status
}

/** One face in the presence stack — the shared Avatar, under the name the
 *  canvas chrome has always called it. */
export function PresenceFace(props: {
  name: string
  color: string
  kind: Presence['kind']
  glaze?: boolean
  glazeDelay?: number
  size?: number
  className?: string
  style?: CSSProperties
}) {
  return <Avatar {...props} />
}

/** The other people and agents on the canvas, as faces in the presence
 *  stack. A person's face is a toggle: click to follow their camera around,
 *  click again to let go. An agent's face jumps the camera to the frame it is
 *  working on. The stack is a fixed roster — working agents glaze in place. */
export function PeerAvatars({ others }: { others: Presence[] }) {
  /* the second, third… active agent offsets its sweep so they alternate */
  let glazed = 0
  return (
    <>
      {others.map((p) => {
        const glazeDelay = isActiveAgent(p) ? (glazed++ % 2) * 1.3 : 0
        return p.kind === 'user' ? (
          <FollowAvatar key={p.clientId} presence={p} />
        ) : (
          <JumpAvatar key={p.clientId} presence={p} glazeDelay={glazeDelay} />
        )
      })}
    </>
  )
}

/* Every face sits on a fixed stacking level (later faces overlap earlier
   ones, working agents above the rest). The hover lift is a transform, and a
   transform makes its own stacking layer: without the fixed level the face
   would drop behind its neighbours while the lift animates in or out. The
   hovered or focused face is raised above them all. */
const stacked = 'relative z-[1] -ml-[7px] rounded-full first:ml-0'
const clickable =
  'transition-transform hover:z-10 hover:-translate-y-px focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-faint'

function presenceLabel(p: Presence, t: Translate) {
  const agent = p.owner ? t('canvas.agentOf', { owner: p.owner }) : t('canvas.agent')
  return `${p.name}${p.kind === 'agent' ? ` (${agent})` : ''}${p.status ? `: ${p.status}` : ''}`
}

function FollowAvatar({ presence: p }: { presence: Presence }) {
  const t = useT()
  const followed = useStore((s) => s.following === p.clientId)
  const setFollowing = useStore((s) => s.setFollowing)
  return (
    <button
      type="button"
      /* lifted so the next avatar in the stack does not paint over the halo */
      className={cn(stacked, clickable, followed && 'relative z-10')}
      aria-pressed={followed}
      title={followed ? t('canvas.stopFollowing', { name: p.name }) : t('canvas.followAround', { name: p.name })}
      onClick={() => setFollowing(followed ? null : p.clientId)}
    >
      <PresenceFace
        name={p.name}
        color={p.color}
        kind={p.kind}
        /* a halo in their colour marks who we are following */
        style={followed ? { boxShadow: `0 0 0 2px var(--surface), 0 0 0 3.5px ${p.color}` } : undefined}
      />
    </button>
  )
}

function JumpAvatar({ presence: p, glazeDelay }: { presence: Presence; glazeDelay: number }) {
  const t = useT()
  const locatable = useStore((s) => locatePresence(p, s) !== undefined)
  const active = isActiveAgent(p)
  const face = <PresenceFace name={p.name} color={p.color} kind={p.kind} glaze={active} glazeDelay={glazeDelay} />
  if (!locatable) {
    return (
      <span className={cn(stacked, 'relative', active && 'z-[2]')} title={presenceLabel(p, t)}>
        {face}
      </span>
    )
  }
  return (
    <button
      type="button"
      className={cn(stacked, clickable, 'relative', active && 'z-[2]')}
      title={t('canvas.goWhereWorking', { label: presenceLabel(p, t) })}
      onClick={() => {
        const s = useStore.getState()
        const at = locatePresence(p, s)
        if (!at) return
        if ('frameId' in at) s.requestFlyTo(at.frameId)
        else s.requestFlyToPoint(at.point.x, at.point.y)
      }}
    >
      {face}
    </button>
  )
}
