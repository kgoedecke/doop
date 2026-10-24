import { createContext, useContext, useState, type ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { useValueScrub } from '@/hooks/use-value-scrub'
import { ChevronDownIcon } from './icons'

/* The dense property controls of an inspector rail: a 26px row with a label
   column and one or more 26px fields, each carrying a faint unit at its
   right edge. Every field keeps a draft while it is being typed into and
   commits on blur or Enter; a new value from outside replaces the draft. */

const fieldCls =
  'flex h-[26px] min-h-[26px] min-w-0 flex-1 shrink-0 items-center gap-1 rounded-[7px] bg-sub px-2 font-mono text-[11px] text-ink focus-within:bg-surface focus-within:shadow-elevation-1-focus'
const unitCls = 'ml-auto flex-none font-sans text-[10.5px] text-ink-ghost'
const scrubUnitCls =
  'self-stretch content-center -mr-2 pr-2 pl-1 cursor-ew-resize touch-none select-none hover:text-ink'
const scrubTitle = 'Drag to adjust · Shift: ×10 · Alt/Option: ×0.1 · Esc: cancel'

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

export function NumberField({
  label,
  value,
  unit: u,
  prefix,
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
  disabled?: boolean
  placeholder?: string
  className?: string
  onCommit: (v: number) => void
  min?: number
  max?: number
}) {
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
      {prefix && (
        <span className="grid size-3.5 flex-none place-items-center font-sans text-ink-faint" aria-hidden>
          {prefix}
        </span>
      )}
      <input
        aria-label={label}
        disabled={disabled}
        placeholder={placeholder}
        className="w-full min-w-0 bg-transparent font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint"
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
      <span
        className={cn(unitCls, scrub.canScrub && scrubUnitCls)}
        title={scrub.canScrub ? scrubTitle : undefined}
        onPointerDown={scrub.onPointerDown}
        onClick={(e) => scrub.canScrub && e.preventDefault()}
      >
        {u}
      </span>
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
          className={cn(unitCls, scrub.canScrub && scrubUnitCls)}
          title={scrub.canScrub ? scrubTitle : undefined}
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
  className,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  label?: string
  className?: string
  onChange: (v: T) => void
}) {
  return (
    <span className={cn(fieldCls, 'relative font-sans text-[11.5px]', className)}>
      <select
        aria-label={label}
        className="w-full min-w-0 appearance-none bg-transparent pr-3 text-ink outline-none"
        value={value}
        /* a native select only ever reports one of the options it was given */
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon width={10} height={10} className="pointer-events-none absolute right-[7px] text-ink-faint" />
    </span>
  )
}

export function ToggleField({
  value,
  labels,
  onChange,
}: {
  value: boolean
  labels: [string, string]
  onChange: (on: boolean) => void
}) {
  return (
    <div className="flex h-[26px] flex-1 gap-0.5 overflow-hidden rounded-[7px] bg-sub p-0.5">
      {[true, false].map((on, i) => (
        <button
          key={labels[i]}
          type="button"
          aria-pressed={value === on}
          className={cn(
            'flex-1 rounded-[5px] text-[11.5px] text-ink-soft transition-colors hover:text-ink',
            value === on && 'bg-surface font-medium text-ink shadow-ring',
          )}
          onClick={() => value !== on && onChange(on)}
        >
          {labels[i]}
        </button>
      ))}
    </div>
  )
}

/** Swatch + hex. Typing a hex or picking from the swatch commits; clearing
 *  the text removes the colour. */
export function ColorField({
  value,
  label,
  className,
  onCommit,
}: {
  value: string | null
  label?: string
  className?: string
  onCommit: (v: string | null) => void
}) {
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
        <span className="absolute inset-0" style={{ background: value ?? 'transparent' }} />
        <input
          type="color"
          aria-label={label ? `Pick ${label.toLowerCase()}` : 'Pick colour'}
          className="absolute -inset-1 cursor-pointer opacity-0"
          value={value ?? '#ffffff'}
          onChange={(e) => onCommit(e.target.value)}
        />
      </span>
      <input
        aria-label={label}
        className="w-full min-w-0 bg-transparent font-mono text-[11px] uppercase text-ink outline-none placeholder:normal-case placeholder:text-ink-faint"
        value={draft}
        placeholder="none"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </label>
  )
}
