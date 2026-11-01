import { useEffect, useState } from 'react'
import type { Presence } from '../../shared/types'
import { BarPill } from './TopBar'
import { PeerAvatars, PresenceFace, isActiveAgent } from './PeerAvatars'
import { DotMatrix } from './ui/dot-matrix'
import { useT } from '../lib/i18n'

/** How long each active agent's line holds before the next one slips in. */
const ROTATE_MS = 4000

/**
 * The live-presence pill at the centre of the canvas bar. The avatar stack
 * is a fixed roster — you first, then everyone else — and never reorders.
 * Agents that are working wear the silver glaze in place; the 3×3 matrix and
 * a status line ("Claude streaming Canvas editor") follow. With two or more
 * active agents only the status line rotates. With nobody working it reads
 * "N online".
 */
export function LivePresence({
  me,
  others,
  onRenameSelf,
}: {
  me: { name: string; color: string }
  others: Presence[]
  onRenameSelf: () => void
}) {
  const t = useT()
  const active = others.filter(isActiveAgent)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (active.length < 2) return
    const timer = window.setInterval(() => setTick((n) => n + 1), ROTATE_MS)
    return () => window.clearInterval(timer)
  }, [active.length])

  const speaking = active.length ? active[tick % active.length] : undefined
  const online = others.length + 1

  return (
    <BarPill
      className="gap-0 pr-3 pl-2"
      title={others.map((p) => p.name).join(', ') || t('canvas.justYou')}
      aria-live="polite"
    >
      <span className="flex h-6 items-center">
        <button
          type="button"
          className="relative z-[1] rounded-full transition-transform hover:z-10 hover:-translate-y-px focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-faint"
          title={t('canvas.youAre', { name: me.name })}
          onClick={onRenameSelf}
        >
          <PresenceFace name={me.name} color={me.color} kind="user" />
        </button>
        {others.length > 0 && (
          <span className="-ml-[7px] flex items-center">
            <PeerAvatars others={others} />
          </span>
        )}
      </span>
      {speaking ? (
        <>
          <DotMatrix className="ml-3" />
          <span
            key={speaking.clientId + tick}
            className="ml-2 max-w-[340px] min-w-0 animate-[status-in_0.35s_ease] truncate leading-4 motion-reduce:animate-none"
          >
            <b className="font-medium text-ink">{speaking.name}</b> {speaking.status}
          </span>
        </>
      ) : (
        <span className="ml-2.5 whitespace-nowrap leading-4">{t('canvas.online', { online })}</span>
      )}
    </BarPill>
  )
}
