import { useState } from 'react'
import { authClient } from '../lib/auth'
import { navigate } from '../App'
import { posthog } from '../lib/posthog'
import { useMe } from '../lib/me'
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

/** Pieces the signed-in shell repeats on every page: the account menu in the
 *  top bar and the connect card pinned to the bottom of the rail. They live
 *  here so Home and Settings cannot drift apart. */

export function initials(name?: string): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '·'
  const letters = parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]
  return letters.toUpperCase()
}

export function AccountMenu() {
  const { data: session } = authClient.useSession()
  const me = useMe(session?.user.id)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="bare"
          className="grid size-10 flex-none place-items-center rounded-[10px] bg-ink font-display text-[12.5px] font-bold text-white hover:bg-ink hover:text-white hover:opacity-90 sm:size-[34px]"
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
        <DropdownMenuItem
          tone="danger"
          onSelect={() =>
            authClient.signOut().then(() => {
              posthog.reset()
              location.reload()
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

/* ---- icons ---- */

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.9 } as const

export function IconGrid() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  )
}

export function IconList() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  )
}

export function IconUser() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="3.2" />
    </svg>
  )
}

export function IconShare() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="3.2" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.8" />
    </svg>
  )
}

export function IconSpark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden>
      <path d="M12 1.6l2.4 7.5 7.5 2.4-7.5 2.4-2.4 7.5-2.4-7.5L2.1 11.5l7.5-2.4z" />
    </svg>
  )
}

export function IconGear() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9 2 2 0 1 1-2.8 2.8 1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2 2 2 0 1 1-2.8-2.8A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9 2 2 0 1 1 2.8-2.8A1.7 1.7 0 0 0 10 4.2a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2 2 2 0 1 1 2.8 2.8A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z" />
    </svg>
  )
}

export function IconShield() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden>
      <path d="M12 3l7 3v6c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z" />
    </svg>
  )
}

export function IconHelp() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.6 2.6 0 1 1 3.4 2.5c-.6.2-.9.7-.9 1.3v.4M12 17h.01" />
    </svg>
  )
}

export function IconOut() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden>
      <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" />
      <path d="m15 16 4-4-4-4M19 12H9" />
    </svg>
  )
}

export function IconBack() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
      <path d="m14 6-6 6 6 6" />
    </svg>
  )
}

export function IconChevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}
