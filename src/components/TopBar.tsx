import { useState } from 'react'
import { navigate } from '../App'
import { Logo } from './Logo'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Tooltip } from './ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * The top bar of a full-screen working surface — the canvas screen and the
 * automation editor share it, so a name field, a view switch and an action
 * cluster look and behave the same on both. Three tiers: desktop is one row
 * with the full action set, tablet folds text actions into a ••• sheet,
 * phone wraps to two rows with the name on top.
 */
export function TopBar({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="top-bar"
      className={cn(
        'z-40 flex h-14 flex-none items-center gap-4 border-b border-line bg-surface px-4 max-md:gap-2.5 max-md:px-3 max-xs:h-[100px] max-xs:flex-wrap max-xs:content-center max-xs:gap-y-2 max-xs:py-2',
        className,
      )}
      {...props}
    />
  )
}

/** The Doop mark at the left edge: the way back to the level above. */
export function TopBarHome({ label, to }: { label: string; to: string }) {
  return (
    <Tooltip label={label} side="bottom" align="start">
      <Button
        variant="bare"
        size="icon-sm"
        className="size-9 hover:bg-paper-deep"
        onClick={() => navigate(to)}
        aria-label={label}
      >
        <Logo className="size-6" />
      </Button>
    </Tooltip>
  )
}

const titleCls = 'min-w-0 max-w-[240px] sm:min-w-[60px] sm:max-w-[320px]'

/** The editable name in the bar. Edits are local until blur or Enter, then
 *  `onCommit` gets the trimmed value — never an empty one. */
export function TopBarTitle({
  value,
  onCommit,
  placeholder = 'Untitled',
  loading = false,
}: {
  value: string
  onCommit: (name: string) => void
  placeholder?: string
  loading?: boolean
}) {
  const [draft, setDraft] = useState<string | null>(null)
  if (loading) return <span className={cn(titleCls, 'px-2 py-[5px] font-display text-[15px] font-semibold')}>…</span>
  const shown = draft ?? value
  return (
    <Input
      variant="title"
      inputSize="sm"
      className={cn(titleCls, 'truncate max-xs:max-w-[calc(100vw-72px)]')}
      value={shown}
      placeholder={placeholder}
      size={Math.max(6, (shown || placeholder).length)}
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft.trim() && draft.trim() !== value) onCommit(draft.trim())
        setDraft(null)
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

/** Hairline between the bar's clusters: actions | presence | sharing. */
export function BarDivider() {
  return <span aria-hidden className="mx-1 h-[22px] w-px bg-line-soft" />
}

/* the bar's button sizes, so every screen's actions line up */
export const barGhostBtn =
  'h-[34px] rounded-[7px] bg-surface px-[17px] text-[12.5px] font-semibold hover:border-ink-faint hover:bg-paper-deep'
export const barIconBtn =
  'size-[34px] rounded-[7px] bg-surface hover:border-ink-faint hover:bg-paper-deep disabled:opacity-40'
export const barPrimaryBtn = 'h-[34px] rounded-[7px] px-[13px] text-[12.5px]'
