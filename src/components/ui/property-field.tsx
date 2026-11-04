import { createContext, useContext, useState, type ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { useValueScrub } from '@/hooks/use-value-scrub'
import { ChevronDownIcon, UnlinkIcon } from './icons'

/* The dense property controls of an inspector rail: a 26px row with a label
   column and one or more 26px fields, each carrying a faint unit at its
   right edge. Every field keeps a draft while it is being typed into and
   commits on blur or Enter; a new value from outside replaces the draft. */

const fieldCls =
  'group relative flex h-[26px] min-h-[26px] min-w-0 flex-1 shrink-0 items-center gap-1 rounded-[7px] bg-sub px-2 font-mono text-[11px] text-ink focus-within:bg-surface focus-within:shadow-elevation-1-focus'
const unitCls = 'ml-auto flex-none font-sans text-[10.5px] text-ink-ghost'
const scrubUnitCls =
  'self-stretch content-center -mr-2 pr-2 pl-1 cursor-ew-resize touch-none select-none hover:text-ink'

/** The panel owns CSS snapshots and persistence; fields only own the gesture. */
export const PropertyScrubContext = createContext<{
  onStart: () => void
  onEnd: (cancel: boolean) => void
} | null>(null)

/** A read-only field in the same shell, for values the rail reports but does not edit. */
export function StaticField({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn(fieldCls, 'text-ink-soft', className)}>{children}</div>
}

export function FieldUnit({ children }: { children: ReactNode }) {
  return <span className={unitCls}>{children}</span>
}

export function PropertySection({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="border-b border-line-soft px-3 pt-[7px] pb-2.5 last:border-b-0">
      <div className="mb-[5px] flex min-h-5 items-center justify-between">
        <h3 className="text-[12px] font-normal text-ink-soft">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

export function PropertyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-1.5 grid min-h-[26px] grid-cols-[58px_1fr] items-center gap-1.5">
      <span className="text-[11.5px] text-ink-faint">{label}</span>
      <div className="flex min-w-0 gap-1.5">{children}</div>
    </div>
  )
}

/** A design token the field's property is bound to (`var(--name)` inline):
 *  the field shows the name in place of the value, and a click detaches it. */
export interface FieldToken {
  name: string
  /** the resolved colour, for a swatch */
  swatch?: string
  onDetach: () => void
}

/** The bound token's name, read-only, and the broken-chain control that
 *  detaches the field from it. */
function TokenChip({ token }: { token: FieldToken }) {
  const t = useT()
  return (
    <>
      <span
        className="min-w-0 flex-1 truncate rounded-[4px] bg-paper-deep px-1 font-mono text-[10.5px] text-ink"
        title={t('inspector.tokenBound', { name: token.name })}
      >
        {token.name}
      </span>
      <button
        type="button"
        aria-label={t('inspector.tokenDetach', { name: token.name })}
        title={t('inspector.tokenDetach', { name: token.name })}
        className="ml-auto grid size-5 flex-none place-items-center rounded-[5px] text-ink-faint hover:bg-paper-deep hover:text-ink"
        onClick={token.onDetach}
      >
        <UnlinkIcon size={11} />
      </button>
    </>
  )
}

export function NumberField({
  label,
  value,
  unit: u,
  prefix,
  trailing,
  token,
  disabled,
  placeholder,
  className,
  onCommit,
  min = 0,
  max = Infinity,
}: {
  label?: string
  value: number | null
  unit: string
  prefix?: ReactNode
  /** a control after the unit: the token menu */
  trailing?: ReactNode
  token?: FieldToken
  disabled?: boolean
  placeholder?: string
  className?: string
  onCommit: (v: number) => void
  min?: number
  max?: number
}) {
  const t = useT()
  const shown = value === null ? '' : String(value)
  const [draft, setDraft] = useState(shown)
  const [seen, setSeen] = useState({ value: shown, scrubbing: false })
  const scrubLifecycle = useContext(PropertyScrubContext)
  const scrub = useValueScrub({
    ...scrubLifecycle,
    value: draft,
    enabled: !disabled && draft.trim() !== '' && Number.isFinite(Number(draft)),
    min,
    max,
    onChange: (v) => {
      setDraft(v)
      onCommit(Number(v))
    },
  })
  // A reply received during the drag still needs to replace the draft on
  // release, even when CSS constrained or rounded it back to the old value.
  if (seen.value !== shown || seen.scrubbing !== scrub.scrubbing) {
    setSeen({ value: shown, scrubbing: scrub.scrubbing })
    if (!scrub.scrubbing) setDraft(shown)
  }
  function commit() {
    if (scrub.scrubbing) return
    const n = Number(draft)
    if (draft.trim() !== '' && Number.isFinite(n) && n !== value) {
      const next = Math.min(max, Math.max(min, n))
      setDraft(String(next))
      onCommit(next)
    } else setDraft(shown)
  }
  return (
    <label className={cn(fieldCls, disabled && 'opacity-50', className)}>
      <span className="flex min-w-0 flex-1 items-baseline gap-1">
        {prefix && (
          <span
            className={cn(
              'grid w-3.5 flex-none place-items-center font-sans text-ink-faint',
              typeof prefix !== 'string' && 'self-center',
            )}
            aria-hidden
          >
            {prefix}
          </span>
        )}
        {token ? (
          <TokenChip token={token} />
        ) : (
          <input
            aria-label={label}
            disabled={disabled}
            placeholder={placeholder}
            className={cn(
              'w-full min-w-0 bg-transparent font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint',
              trailing && 'group-hover:pr-5',
            )}
            value={draft}
            inputMode="decimal"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault()
                const n = Number(draft) || 0
                const next = Math.min(max, Math.max(min, n + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)))
                setDraft(String(next))
                onCommit(next)
              }
            }}
          />
        )}
      </span>
      {!token && (
        <span
          data-unit
          className={cn(unitCls, scrub.canScrub && scrubUnitCls)}
          title={scrub.canScrub ? t('inspector.scrubHint') : undefined}
          onPointerDown={scrub.onPointerDown}
          onClick={(e) => scrub.canScrub && e.preventDefault()}
        >
          {u}
        </span>
      )}
      {/* over the value's tail, left of the unit, so the unit stays where a scrub finds it */}
      {trailing && <span className="absolute inset-y-0 right-7 flex items-center">{trailing}</span>}
    </label>
  )
}

export function TextField({
  label,
  value,
  unit: u,
  placeholder,
  className,
  onCommit,
  scrub: scrubbable = false,
  min,
}: {
  label?: string
  value: string
  unit?: string
  placeholder?: string
  className?: string
  onCommit: (v: string) => void
  scrub?: boolean
  min?: number
}) {
  const t = useT()
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState({ value, scrubbing: false })
  const scrubLifecycle = useContext(PropertyScrubContext)
  const scrub = useValueScrub({
    ...scrubLifecycle,
    value: draft,
    enabled: scrubbable,
    min,
    onChange: (v) => {
      setDraft(v)
      onCommit(v)
    },
  })
  if (seen.value !== value || seen.scrubbing !== scrub.scrubbing) {
    setSeen({ value, scrubbing: scrub.scrubbing })
    if (!scrub.scrubbing) setDraft(value)
  }
  return (
    <label className={cn(fieldCls, className)}>
      <input
        aria-label={label}
        className="w-full min-w-0 bg-transparent font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => !scrub.scrubbing && draft !== value && onCommit(draft)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      {u && (
        <span
          data-unit
          className={cn(unitCls, scrub.canScrub && scrubUnitCls)}
          title={scrub.canScrub ? t('inspector.scrubHint') : undefined}
          onPointerDown={scrub.onPointerDown}
          onClick={(e) => scrub.canScrub && e.preventDefault()}
        >
          {u}
        </span>
      )}
    </label>
  )
}

/** A CSS length keeps its unit while dragging; keywords remain editable text. */
export function LengthField({
  label,
  value,
  onCommit,
  placeholder,
}: {
  label?: string
  value: string
  onCommit: (v: string) => void
  placeholder?: string
}) {
  const length = /^(-?(?:\d+\.?\d*|\.\d+))([a-z%]+)?$/.exec(value)
  const unit = length?.[2] ?? 'px'
  return (
    <TextField
      label={label}
      value={length?.[1] ?? value}
      unit={unit}
      placeholder={placeholder}
      scrub
      min={0}
      onCommit={(v) => onCommit(/^-?(?:\d+\.?\d*|\.\d+)$/.test(v.trim()) ? `${v.trim()}${unit}` : v)}
    />
  )
}

export function SelectField<T extends string>({
  value,
  options,
  label,
  placeholder,
  className,
  onChange,
}: {
  /** null shows `placeholder` (a mixed value) until an option is picked */
  value: T | null
  /* consecutive options sharing a `group` render under one <optgroup> */
  options: { value: T; label: string; group?: string }[]
  label?: string
  placeholder?: string
  className?: string
  onChange: (v: T) => void
}) {
  const runs: { group?: string; options: typeof options }[] = []
  for (const o of options) {
    const last = runs.at(-1)
    if (last && last.group === o.group) last.options.push(o)
    else runs.push({ group: o.group, options: [o] })
  }
  const items = (list: typeof options) =>
    list.map((o) => (
      <option key={o.value} value={o.value}>
        {o.label}
      </option>
    ))
  return (
    <span className={cn(fieldCls, 'relative font-sans text-[11.5px]', className)}>
      <select
        aria-label={label}
        className="w-full min-w-0 appearance-none bg-transparent pr-3 text-ink outline-none"
        value={value ?? ''}
        /* a native select only ever reports one of the options it was given */
        onChange={(e) => e.target.value !== '' && onChange(e.target.value as T)}
      >
        {value === null && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {runs.map((run, i) =>
          run.group ? (
            <optgroup key={`${run.group}-${i}`} label={run.group}>
              {items(run.options)}
            </optgroup>
          ) : (
            items(run.options)
          ),
        )}
      </select>
      <ChevronDownIcon width={10} height={10} className="pointer-events-none absolute right-[7px] text-ink-faint" />
    </span>
  )
}

/** Swatch + hex. Typing a hex or picking from the swatch commits; clearing
 *  the text removes the colour. */
export function ColorField({
  value,
  label,
  placeholder,
  className,
  trailing,
  token,
  onCommit,
}: {
  value: string | null
  label?: string
  /** shown for a null value in place of "none" (a mixed colour) */
  placeholder?: string
  className?: string
  /** a control after the hex: the token menu */
  trailing?: ReactNode
  token?: FieldToken
  onCommit: (v: string | null) => void
}) {
  const t = useT()
  const shown = value ?? ''
  const [draft, setDraft] = useState(shown)
  const [seen, setSeen] = useState(shown)
  if (seen !== shown) {
    setSeen(shown)
    setDraft(shown)
  }
  function commit() {
    const v = draft.trim().toLowerCase()
    if (v === '') {
      if (value !== null) onCommit(null)
      return
    }
    const hex = v.startsWith('#') ? v : `#${v}`
    if (/^#[0-9a-f]{6}$/.test(hex)) {
      if (hex !== value) onCommit(hex)
    } else setDraft(shown)
  }
  return (
    <label className={cn(fieldCls, 'gap-1.5', className)}>
      <span className="relative size-3 flex-none overflow-hidden rounded-[3px] border border-line">
        <span
          className="absolute inset-0"
          style={{ background: token ? (token.swatch ?? 'transparent') : (value ?? 'transparent') }}
        />
        {!token && (
          <input
            type="color"
            aria-label={label ? t('inspector.pickLabel', { label: label.toLowerCase() }) : t('inspector.pickColour')}
            className="absolute -inset-1 cursor-pointer opacity-0"
            value={value ?? '#ffffff'}
            onChange={(e) => onCommit(e.target.value)}
          />
        )}
      </span>
      {token ? (
        <TokenChip token={token} />
      ) : (
        <input
          aria-label={label}
          className={cn(
            'w-full min-w-0 bg-transparent font-mono text-[11px] uppercase text-ink outline-none placeholder:normal-case placeholder:text-ink-faint',
            trailing && 'group-hover:pr-5',
          )}
          value={draft}
          placeholder={placeholder ?? t('inspector.colorNone')}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      )}
      {trailing && (
        <span className={cn('absolute inset-y-0 flex items-center', token ? 'right-7' : 'right-1')}>{trailing}</span>
      )}
    </label>
  )
}
