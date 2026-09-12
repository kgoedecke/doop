import type { AgentRole } from '../../shared/agents'
import { DoopMark } from './Logo'
import { cn } from '@/lib/utils'

/** A role's badge: a filled circle in the role's crew colour with the white
 *  Doop mark inside, as on the marketing site's team section. `size` is the
 *  circle's diameter; the mark takes about half of it. An unknown role gets a
 *  neutral ink circle so a stale card still reads. */
export function RoleMark({
  role,
  size = 14,
  className,
  style,
}: {
  role?: Pick<AgentRole, 'color'>
  size?: number
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <span
      className={cn('inline-grid flex-none place-items-center rounded-full align-middle', className)}
      style={{ width: size, height: size, background: role?.color ?? 'var(--ink-faint)', ...style }}
      aria-hidden
    >
      <DoopMark size={Math.round(size * 0.55)} color="#fff" className="block" />
    </span>
  )
}
