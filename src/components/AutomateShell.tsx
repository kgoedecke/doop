import type { SVGProps } from 'react'
import { roleById } from '../../shared/agents'
import { RoleMark } from './RoleMark'
import { BrandMark } from './ui/brand-mark'
import { Dot } from './ui/dot'
import { CheckIcon, ClockIcon } from './ui/icons'
import { cn } from '@/lib/utils'
import { clientIntegrations } from '../integrations'

/**
 * Pieces the Automations and Integrations pages share: the provider and
 * trigger marks and the run status dot. Controls come from `ui/` (Switch,
 * Select). The rail itself is the shell's AppRail. Visual reference: the
 * "Automations 0/1/5" frames on the Doop Dashboard canvas.
 */

export type AutomatePage = 'automations' | 'integrations'

/* ---- marks ---- */

/** The trigger's mark: a clock on an ink tile. */
export function ClockTile({ size = 24, className }: { size?: number; className?: string }) {
  const icon = Math.round(size * 0.58)
  return (
    <span
      className={cn('inline-grid flex-none place-items-center rounded-row bg-ink', className)}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.29) }}
      aria-hidden
    >
      <ClockIcon width={icon} height={icon} strokeWidth={1.9} className="text-paper" />
    </span>
  )
}

/** Meta's mark on a paper tile — the provider's own identity, not a Doop role. */
export function MetaTile({ size = 24, className }: { size?: number; className?: string }) {
  const icon = Math.round(size * 0.58)
  return (
    <span
      className={cn('inline-grid flex-none place-items-center bg-paper-deep', className)}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.29) }}
      aria-hidden
    >
      <MetaLogo width={icon} height={icon} />
    </span>
  )
}

/** Meta's mark, from the BrandMark registry; the square it fills is `width`. */
export function MetaLogo({ width = 16, className }: Pick<SVGProps<SVGSVGElement>, 'width' | 'height' | 'className'>) {
  return <BrandMark brand="meta" size={Number(width)} className={className} />
}

export function ApprovalTile({ size = 24 }: { size?: number }) {
  return (
    <span
      /* white on the green fill, like text on brand: success-ink nearly
         matches the fill in dark mode */
      className="inline-grid flex-none place-items-center rounded-row bg-success text-white"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <CheckIcon width={size * 0.6} height={size * 0.6} strokeWidth={2.25} />
    </span>
  )
}

type MarkStep = { type: 'pull'; provider?: string } | { type: 'agent'; roles: string[] } | { type: 'slack' | 'linear' }

/** The chain that summarises an automation: clock, then a Meta tile per
 *  pull and a role mark per agent, joined by short dashes when `joined`. */
export function StepChain({
  steps,
  size = 26,
  joined = true,
  className,
  approval = false,
}: {
  steps: MarkStep[]
  size?: number
  joined?: boolean
  className?: string
  approval?: boolean
}) {
  const marks: React.ReactNode[] = [
    approval ? <ApprovalTile key="approval" size={size} /> : <ClockTile key="clock" size={size} />,
  ]
  steps.forEach((s, i) => {
    if (s.type === 'pull')
      marks.push(<PullMark key={`p${i}`} provider={s.provider} size={size} className="border border-line bg-surface" />)
    else if (s.type === 'slack' || s.type === 'linear')
      marks.push(<PullMark key={`d${i}`} provider={s.type} size={size} />)
    else if (s.type === 'agent')
      marks.push(
        <span key={`a${i}`} className="flex">
          {s.roles.map((id, j) => (
            <RoleMark
              key={id}
              role={roleById(id)}
              size={size}
              className={cn(j > 0 && 'ring-[1.5px] ring-surface')}
              style={j > 0 ? { marginLeft: -Math.round(size * 0.3) } : undefined}
            />
          ))}
        </span>,
      )
  })
  const dash = <span className="h-px w-3 flex-none bg-line" aria-hidden />
  return (
    <span className={cn('inline-flex items-center', joined ? 'gap-1.5' : 'gap-1', className)}>
      {marks.map((m, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          {i > 0 && joined && dash}
          {m}
        </span>
      ))}
    </span>
  )
}

/** The status dot a run row leads with: the shared Dot, toned by the run's outcome. */
const RUN_TONE = { running: 'running', ok: 'done', failed: 'failed' } as const

export function RunDot({ status, className }: { status: keyof typeof RUN_TONE; className?: string }) {
  return <Dot tone={RUN_TONE[status]} className={className} role="img" aria-hidden={false} aria-label={status} />
}

/** "Mon, Sep 8 · 9:00 AM" — in the viewer's locale, so the clock reads the
 *  way their system shows it. */
export function formatRunTime(at: number): string {
  const d = new Date(at)
  const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${day} · ${time}`
}

/** The pulling integration's mark. Meta's without a provider (older rows),
 *  a registered integration's own tile, and a neutral paper tile for one
 *  that registered none — never another integration's logo. */
export function PullMark({ provider, size = 24, className }: { provider?: string; size?: number; className?: string }) {
  if (!provider || provider === 'meta') return <MetaTile size={size} className={className} />
  const Tile = clientIntegrations.find((i) => i.id === provider)?.Tile
  if (Tile) return <Tile size={size} className={className} />
  return (
    <span
      className={cn('inline-grid flex-none place-items-center bg-paper-deep font-mono text-ink-soft', className)}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.29), fontSize: Math.round(size * 0.45) }}
      aria-hidden
    >
      {provider.slice(0, 1).toUpperCase()}
    </span>
  )
}
