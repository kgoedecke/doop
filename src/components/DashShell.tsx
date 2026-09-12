import { useState } from 'react'
import { authClient } from '../lib/auth'
import { navigate } from '../App'
import { posthog } from '../lib/posthog'
import { useMe } from '../lib/me'
import { isDesktopShell } from '../lib/shell'
import { useTheme } from '../lib/theme'
import { cn } from '@/lib/utils'
import { AgentIcon } from './AgentIcon'
import { ConnectModal } from './ConnectModal'
import { CodeBlock } from './ui/code-block'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  CompassIcon,
  GearIcon,
  GridIcon,
  HelpIcon,
  ListIcon,
  LogOutIcon,
  PulseIcon,
  ShieldIcon,
  SparkIcon,
  UserIcon,
  UsersIcon,
} from './ui/icons'

/** Pieces the signed-in shell repeats on every page: the account menu in the
 *  top bar and the connect card pinned to the bottom of the rail. They live
 *  here so Home and Settings cannot drift apart. */

export function initials(name?: string): string {
  const [first, ...rest] = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!first) return '·'
  const last = rest[rest.length - 1]
  const letters = last ? first.slice(0, 1) + last.slice(0, 1) : first.slice(0, 2)
  return letters.toUpperCase()
}

export function AccountMenu() {
  const { data: session } = authClient.useSession()
  const me = useMe(session?.user.id)
  const { theme, setTheme } = useTheme()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="bare"
          className="grid size-10 flex-none place-items-center rounded-[10px] bg-ink font-display text-[12.5px] font-bold text-paper hover:bg-ink hover:text-paper hover:opacity-90 sm:size-[34px]"
          aria-label="Account"
        >
          {initials(session?.user.name)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel className="flex items-center gap-[11px] px-2.5 pb-3 pt-[11px]">
          <span className="grid size-[42px] flex-none place-items-center rounded-[12px] border border-line bg-paper-deep font-display text-[14px] font-extrabold">
            {initials(session?.user.name)}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-display text-[14px] font-bold">{session?.user.name}</span>
            <span className="mt-px truncate text-[12px] font-normal text-ink-faint">
              {me?.email ?? session?.user.email}
            </span>
          </span>
        </DropdownMenuLabel>
        <div className="mx-2.5 mb-2 flex items-center gap-[7px] text-[11.5px] text-ink-soft">
          <Badge>beta</Badge> Free while in beta
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/settings')}>
          <IconGear /> Settings
        </DropdownMenuItem>
        {me?.admin && (
          <DropdownMenuItem onSelect={() => navigate('/admin')}>
            <IconShield /> Admin
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <a href="https://doop.design/docs" target="_blank" rel="noopener noreferrer">
            <IconHelp /> Help &amp; docs
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="px-2.5 py-1.5">
          <div className="mb-1 text-[11px] font-semibold tracking-wider text-ink-faint uppercase">Theme</div>
          <div className="flex items-center gap-1 rounded-[8px] border border-line bg-paper-deep p-1">
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault()
                setTheme('light')
              }}
              className={cn(
                'flex flex-1 items-center justify-center gap-1 rounded-[6px] py-1 text-[11.5px] font-medium transition-colors',
                theme === 'light' ? 'bg-surface text-ink shadow-sm' : 'text-ink-soft hover:text-ink',
              )}
            >
              <IconSun /> Light
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault()
                setTheme('dark')
              }}
              className={cn(
                'flex flex-1 items-center justify-center gap-1 rounded-[6px] py-1 text-[11.5px] font-medium transition-colors',
                theme === 'dark' ? 'bg-surface text-ink shadow-sm' : 'text-ink-soft hover:text-ink',
              )}
            >
              <IconMoon /> Dark
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault()
                setTheme('system')
              }}
              className={cn(
                'flex flex-1 items-center justify-center gap-1 rounded-[6px] py-1 text-[11.5px] font-medium transition-colors',
                theme === 'system' ? 'bg-surface text-ink shadow-sm' : 'text-ink-soft hover:text-ink',
              )}
            >
              <IconLaptop /> System
            </button>
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          tone="danger"
          onSelect={() =>
            authClient.signOut().then(() => {
              posthog.reset()
              /* the shell has no marketing site: a signed-out reload of /
                 would show the landing page, so it goes to the sign-in form
                 the shell opens on (main.rs) */
              if (isDesktopShell()) location.assign('/auth')
              else location.reload()
            })
          }
        >
          <IconOut /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The rail's bottom slot. Same card on every page — the quick command for the
 *  common case, and the full per-client instructions a click away. */
export function ConnectCard() {
  const [showConnect, setShowConnect] = useState(false)
  return (
    <>
      <div className="rounded-[12px] border border-dashed border-line px-[13px] py-3">
        <b className="block font-display text-[12.5px]">Connect an agent</b>
        <p className="mt-[3px] text-[11.5px] leading-[1.45] text-ink-faint">
          Any MCP client — one command, one browser approval.
        </p>
        <span className="mt-[9px] flex items-center gap-2">
          <AgentIcon name="claude" size={14} />
          <AgentIcon name="codex" size={14} color="var(--ink)" />
          <em className="text-[10.5px] not-italic text-ink-faint">+ any MCP</em>
        </span>
        <CodeBlock
          density="rail"
          className="mt-2"
          text={`claude mcp add --transport http doop "${location.origin}/mcp"`}
        />
        <Button
          variant="link"
          size="sm"
          className="mt-[9px] px-0 py-0 text-[11.5px] text-accent-ink underline-offset-[3px]"
          onClick={() => setShowConnect(true)}
        >
          Codex &amp; other clients →
        </Button>
      </div>
      {showConnect && <ConnectModal onClose={() => setShowConnect(false)} />}
    </>
  )
}

/* ---- icons ----
   The shell's nav glyphs, at the rail's 15px, drawn from the shared set. */

const rail = { width: 15, height: 15, 'aria-hidden': true } as const

export const IconGrid = () => <GridIcon {...rail} />
export const IconList = () => <ListIcon {...rail} />
export const IconUser = () => <UserIcon {...rail} />
export const IconShare = () => <UsersIcon {...rail} />
/** the gallery: a compass — designs to steer by */
export const IconCommunity = () => <CompassIcon {...rail} />
/** a clock — things that happen on a schedule */
export const IconAutomations = () => <ClockIcon {...rail} />
/** a pulse line — a live connection */
export const IconIntegrations = () => <PulseIcon {...rail} />
export const IconSpark = () => <SparkIcon {...rail} />
export const IconGear = () => <GearIcon {...rail} />
export const IconShield = () => <ShieldIcon {...rail} />
export const IconHelp = () => <HelpIcon {...rail} />
export const IconOut = () => <LogOutIcon {...rail} />
export const IconBack = () => <ChevronLeftIcon width={14} height={14} aria-hidden />
export const IconChevron = () => <ChevronRightIcon width={12} height={12} aria-hidden />

export function IconSun() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  )
}

export function IconMoon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  )
}

export function IconLaptop() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M2 20h20" />
    </svg>
  )
}
