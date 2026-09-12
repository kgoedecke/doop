import { useMemo, useState, type SVGProps } from 'react'
import { navigate } from '../App'
import { colorFor, type CanvasMeta } from '../../shared/types'
import { roleById } from '../../shared/agents'
import { timeAgo } from '../lib/time'
import { AgentIcon } from './AgentIcon'
import { ConnectCard, IconAutomations, IconGrid, IconIntegrations, IconShare, IconUser } from './DashShell'
import { NavItem } from '../pages/Home'
import { RoleMark } from './RoleMark'
import { DashSectionLabel, DashSidebar } from './ui/dash'
import { Dot } from './ui/dot'
import { Wordmark } from './ui/wordmark'
import { fieldVariants } from './ui/input'
import { cn } from '@/lib/utils'

/**
 * Pieces the Automations and Integrations pages share with the rest of the
 * signed-in shell: the Home rail (with these two pages in its main nav), the
 * provider and trigger marks, and the small controls the node editor is
 * built from. Visual reference: the "Automations 0/1/5" frames on the Doop
 * Dashboard canvas.
 */

export type AutomatePage = 'automations' | 'integrations'

/** an agent that worked this recently is treated as still at the desk */
const LIVE_WINDOW = 5 * 60 * 1000

/** The Home rail as the design draws it on these pages: canvases nav, then
 *  Automations and Integrations in the same list, then the agents seen
 *  across the user's canvases. */
export function WorkspaceRail({
  active,
  canvases,
  automationCount,
  integrationCount,
}: {
  active: AutomatePage
  canvases: CanvasMeta[]
  automationCount?: number
  integrationCount?: number
}) {
  const agents = useMemo(() => {
    const map = new Map<string, { name: string; lastAt: number }>()
    for (const c of canvases) {
      for (const a of c.agents ?? []) {
        const e = map.get(a.name)
        if (e) e.lastAt = Math.max(e.lastAt, a.lastAt ?? 0)
        else map.set(a.name, { name: a.name, lastAt: a.lastAt ?? 0 })
      }
    }
    return [...map.values()].sort((x, y) => y.lastAt - x.lastAt).slice(0, 5)
  }, [canvases])
  /* read once per mount: liveness is a rail-level glance, not a clock */
  const [now] = useState(() => Date.now())
  const mine = canvases.filter((c) => !c.shared).length
  const shared = canvases.length - mine

  return (
    <DashSidebar>
      <Wordmark size="sm" className="px-2 pb-5 text-[17px]" />
      <nav className="flex flex-col gap-0.5">
        <NavItem icon={<IconGrid />} label="All canvases" count={canvases.length} on={false} go={() => navigate('/')} />
        <NavItem icon={<IconUser />} label="Owned by me" count={mine} on={false} go={() => navigate('/')} />
        <NavItem icon={<IconShare />} label="Shared with me" count={shared} on={false} go={() => navigate('/')} />
        <NavItem
          icon={<IconAutomations />}
          label="Automations"
          count={automationCount}
          on={active === 'automations'}
          go={() => navigate('/automations')}
        />
        <NavItem
          icon={<IconIntegrations />}
          label="Integrations"
          count={integrationCount}
          on={active === 'integrations'}
          go={() => navigate('/integrations')}
        />
      </nav>

      {agents.length > 0 && (
        <>
          <DashSectionLabel>Agents</DashSectionLabel>
          <div className="flex flex-col gap-0.5">
            {agents.map((a) => (
              <div
                key={a.name}
                className="flex min-w-0 items-center gap-[9px] px-2.5 py-[5px] text-[13px] text-ink-soft"
              >
                <span
                  className="grid size-[22px] flex-none place-items-center rounded-[7px] bg-paper-deep"
                  style={{ color: colorFor(a.name) }}
                >
                  <AgentIcon name={a.name} size={13} />
                </span>
                <span className="truncate">{a.name}</span>
                {a.lastAt > 0 && now - a.lastAt < LIVE_WINDOW ? (
                  <Dot size="sm" className="ml-auto bg-[#3f9c52] shadow-[0_0_0_3px_rgba(63,156,82,0.15)]" />
                ) : (
                  <span className="ml-auto flex-none font-mono text-[10.5px] text-ink-faint">
                    {a.lastAt > 0 ? timeAgo(a.lastAt) : ''}
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <div className="min-h-6 flex-1" />
      <ConnectCard />
    </DashSidebar>
  )
}

/* ---- marks ---- */

/** The trigger's mark: a clock on an ink tile. */
export function ClockTile({ size = 24, className }: { size?: number; className?: string }) {
  const icon = Math.round(size * 0.58)
  return (
    <span
      className={cn('inline-grid flex-none place-items-center rounded-[7px] bg-ink', className)}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.29) }}
      aria-hidden
    >
      <svg
        width={icon}
        height={icon}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#fdfdfc"
        strokeWidth="1.9"
        strokeLinecap="round"
      >
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </svg>
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

export function MetaLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="#0866FF" aria-hidden {...props}>
      <path d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.499-1.584.325-.217.65-.234.972-.234z" />
    </svg>
  )
}

type MarkStep = { type: 'pull' } | { type: 'agent'; roles: string[] }

/** The chain that summarises an automation: clock, then a Meta tile per
 *  pull and a role mark per agent, joined by short dashes when `joined`. */
export function StepChain({
  steps,
  size = 26,
  joined = true,
  className,
}: {
  steps: MarkStep[]
  size?: number
  joined?: boolean
  className?: string
}) {
  const marks: React.ReactNode[] = [<ClockTile key="clock" size={size} />]
  steps.forEach((s, i) => {
    if (s.type === 'pull') marks.push(<MetaTile key={`p${i}`} size={size} className="border border-line bg-surface" />)
    else
      marks.push(
        <span key={`a${i}`} className="flex">
          {s.roles.map((id, j) => (
            <RoleMark
              key={id}
              role={roleById(id)}
              size={size}
              className={cn(j > 0 && 'ring-[1.5px] ring-white')}
              style={j > 0 ? { marginLeft: -Math.round(size * 0.3) } : undefined}
            />
          ))}
        </span>,
      )
  })
  const dash = <span className="h-px w-3 flex-none bg-[#b9b5ac]" aria-hidden />
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

/* ---- controls ---- */

/** The brand-blue switch from the designs, with its mono "ON/OFF" caption. */
export function Toggle({
  on,
  onChange,
  label,
  caption = false,
  disabled,
}: {
  on: boolean
  onChange: (on: boolean) => void
  label: string
  caption?: boolean
  disabled?: boolean
}) {
  return (
    <span className="inline-flex items-center gap-2">
      {caption && (
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft">{on ? 'On' : 'Off'}</span>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation()
          onChange(!on)
        }}
        className={cn(
          'relative h-5 w-[34px] flex-none rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50',
          on ? 'bg-brand' : 'bg-line',
        )}
      >
        <span
          className={cn(
            'absolute top-[2px] size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.2)] transition-[left]',
            on ? 'left-[16px]' : 'left-[2px]',
          )}
        />
      </button>
    </span>
  )
}

/** The bordered "value ▾" control the node sentences are made of. A native
 *  select underneath keeps the keyboard; the visible part is styled. */
export function Sel({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <span className={cn('relative inline-flex min-w-0', className)}>
      <select
        className={cn(
          fieldVariants({ variant: 'default', inputSize: 'sm' }),
          'h-[34px] w-full cursor-pointer appearance-none truncate rounded-lg pl-[11px] pr-8 text-[13.5px] font-semibold tracking-[-0.01em]',
        )}
        {...props}
      >
        {children}
      </select>
      <Chevron className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
    </span>
  )
}

export function Chevron({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

/** A canvas's 28×18 preview, or a blank tile when it has no frames yet. */
export function CanvasThumb({ canvas, className }: { canvas?: CanvasMeta; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block h-[18px] w-[28px] flex-none overflow-hidden rounded-[3px] border border-line bg-paper-deep',
        className,
      )}
      aria-hidden
    >
      {canvas?.previewFrameId && (
        <img src={`/i/${canvas.previewFrameId}.jpg?preview`} alt="" className="h-full w-full object-cover object-top" />
      )}
    </span>
  )
}

/** The status dot a run row leads with. */
export function RunDot({ status, className }: { status: 'running' | 'ok' | 'failed'; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block size-[7px] flex-none rounded-full',
        status === 'ok' && 'bg-[#3f9c52]',
        status === 'failed' && 'bg-accent-ink',
        status === 'running' && 'animate-pulse bg-[#8B5CF6]',
        className,
      )}
      aria-label={status}
    />
  )
}

/** "Mon, Sep 8 · 9:00 AM" — in the viewer's locale, so the clock reads the
 *  way their system shows it. */
export function formatRunTime(at: number): string {
  const d = new Date(at)
  const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${day} · ${time}`
}
