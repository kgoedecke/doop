import { useState } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { navigate } from '../App'
import { Logo } from './Logo'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Tooltip } from './ui/tooltip'
import { cn } from '@/lib/utils'

const topBarVariants = cva(
  'z-40 flex flex-none items-center max-xs:h-[100px] max-xs:flex-wrap max-xs:content-center max-xs:gap-y-2 max-xs:py-2',
  {
    variants: {
      variant: {
        /* a full-width strip with a hairline under it (the automation editor) */
        solid: 'h-14 gap-4 border-b border-line-soft bg-surface px-4 max-md:gap-2.5 max-md:px-3',
        /* the canvas editor: no strip at all — floating pills over the
           canvas, which shows through the transparent bar. The pills sit
           14px from the top edge, the same as from the left and right ones.
           Only the pills take the pointer; the gaps between them pan and
           select as canvas. */
        canvas:
          'pointer-events-none absolute inset-x-0 top-0 h-[50px] items-start gap-2.5 bg-transparent px-3.5 pt-3.5 max-md:h-14 max-md:items-center max-md:gap-2 max-md:px-3 max-md:pt-0 [&>*]:pointer-events-auto',
      },
    },
    defaultVariants: { variant: 'solid' },
  },
)

/**
 * The top bar of a full-screen working surface — the canvas screen and the
 * automation editor share it, so a name field, a view switch and an action
 * cluster look and behave the same on both. Three tiers: desktop is one row
 * with the full action set, tablet folds text actions into a ••• sheet,
 * phone wraps to two rows with the name on top.
 */
export function TopBar({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof topBarVariants>) {
  return <div data-slot="top-bar" className={cn(topBarVariants({ variant, className }))} {...props} />
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
 *  `onCommit` gets the trimmed value — never an empty one. `pill` is the
 *  quieter 12px name that sits inside the canvas bar's title pill. */
export function TopBarTitle({
  value,
  onCommit,
  placeholder = 'Untitled',
  loading = false,
  pill = false,
  readOnly = false,
}: {
  value: string
  onCommit: (name: string) => void
  placeholder?: string
  loading?: boolean
  pill?: boolean
  /** shows the name as text: the caller cannot rename it */
  readOnly?: boolean
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const pillCls =
    'h-7 rounded-[6px] px-1.5 font-sans text-[12.5px] font-medium hover:border-transparent hover:bg-paper-deep focus:border-transparent focus:bg-surface focus:shadow-elevation-1-focus md:text-[12.5px]'
  if (loading)
    return (
      <span
        className={cn(
          titleCls,
          pill ? 'px-1.5 text-[12.5px] font-medium' : 'px-2 py-[5px] font-display text-[15px] font-semibold',
        )}
      >
        …
      </span>
    )
  if (readOnly)
    return (
      <span
        className={cn(
          titleCls,
          'truncate',
          pill ? 'px-1.5 text-[12.5px] font-medium' : 'px-2 py-[5px] font-display text-[15px] font-semibold',
        )}
      >
        {value || placeholder}
      </span>
    )
  const shown = draft ?? value
  /* the field is as wide as its text and no wider: an invisible mirror of the
     text in the same font sits in the same grid cell and sets the width, so a
     short name gets a snug pill instead of the padding a character count
     (`size`) would leave after proportional type */
  const fieldCls = cn(titleCls, 'max-xs:max-w-[calc(100vw-72px)]', pill && pillCls)
  return (
    <span className="grid min-w-0">
      <span aria-hidden className={cn(fieldCls, 'invisible col-start-1 row-start-1 whitespace-pre')}>
        {shown || placeholder}
      </span>
      <Input
        variant="title"
        inputSize="sm"
        className={cn(fieldCls, 'col-start-1 row-start-1 truncate')}
        value={shown}
        placeholder={placeholder}
        onFocus={() => setDraft(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null && draft.trim() && draft.trim() !== value) onCommit(draft.trim())
          setDraft(null)
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </span>
  )
}

/** Hairline between the bar's clusters: actions | presence | sharing. */
export function BarDivider({ className }: { className?: string }) {
  return <span aria-hidden className={cn('mx-1 h-[18px] w-px bg-line-soft', className)} />
}

/** A 36px white pill on the canvas bar: the title, the presence line, a
 *  cluster of actions. The ring draws its edge; there is no border. */
export function BarPill({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="bar-pill"
      className={cn(
        'flex h-9 min-w-0 items-center gap-0.5 rounded-[10px] bg-surface px-1 text-[12px] text-ink-soft shadow-ring',
        className,
      )}
      {...props}
    />
  )
}

/** A quiet text-and-icon action inside a BarPill. */
export const barPillBtn =
  'h-[30px] gap-[7px] rounded-[8px] px-2.5 text-[12px] font-medium text-ink hover:bg-paper-deep hover:text-ink [&_svg]:text-ink-soft'
/** An icon-only action inside a BarPill. */
export const barPillIconBtn =
  'size-[30px] rounded-[8px] p-0 text-ink-soft hover:bg-paper-deep hover:text-ink disabled:opacity-40'

/* the bar's button sizes, so every screen's actions line up */
export const barGhostBtn = 'h-9 rounded-[10px] bg-surface px-3.5 text-[12.5px] font-medium hover:bg-paper-deep'
export const barIconBtn = 'size-9 rounded-[10px] bg-surface hover:bg-paper-deep disabled:opacity-40'
export const barPrimaryBtn = 'h-9 rounded-[10px] px-3.5 text-[12.5px] font-medium'
