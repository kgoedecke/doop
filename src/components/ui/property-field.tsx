import { useState, type ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { ChevronDownIcon } from './icons'

/* The dense property controls of an inspector rail: a 26px row with a label
   column and one or more 24px fields, each carrying a faint unit at its
   right edge. Every field keeps a draft while it is being typed into and
   commits on blur or Enter; a new value from outside replaces the draft. */

const fieldCls =
  'flex h-6 min-w-0 flex-1 items-center gap-1 rounded-md border border-line bg-surface px-[7px] font-mono text-[11px] text-ink focus-within:border-ink'
const unitCls = 'ml-auto flex-none text-[9.5px] text-ink-faint'

/** A read-only field in the same shell, for values the rail reports but does not edit. */
export function StaticField({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn(fieldCls, 'text-ink-soft', className)}>{children}</div>
}

export function FieldUnit({ children }: { children: ReactNode }) {
  return <span className={unitCls}>{children}</span>
}

export function PropertySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-line-soft px-3 pt-[9px] pb-[11px]">
      <h3 className="mb-1.5 flex h-5 items-center text-[11.5px] font-bold text-ink">{title}</h3>
      {children}
    </section>
  )
}

export function PropertyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-1 grid min-h-[26px] grid-cols-[58px_1fr] items-center gap-1.5">
      <span className="text-[11px] text-ink-soft">{label}</span>
      <div className="flex min-w-0 gap-1">{children}</div>
    </div>
  )
}

export function NumberField({
  value,
  unit: u,
  className,
  onCommit,
}: {
  value: number | null
  unit: string
  className?: string
  onCommit: (v: number) => void
}) {
  const shown = value === null ? '' : String(value)
  const [draft, setDraft] = useState(shown)
  const [seen, setSeen] = useState(shown)
  if (seen !== shown) {
    setSeen(shown)
    setDraft(shown)
  }
  function commit() {
    const n = Number(draft)
    if (draft.trim() !== '' && !Number.isNaN(n) && n !== value) onCommit(n)
    else setDraft(shown)
  }
  return (
    <label className={cn(fieldCls, className)}>
      <input
        className="w-full min-w-0 bg-transparent font-mono text-[11px] text-ink outline-none"
        value={draft}
        inputMode="decimal"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const n = Number(draft) || 0
            onCommit(n + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1))
          }
        }}
      />
      <span className={unitCls}>{u}</span>
    </label>
  )
}

export function TextField({
  value,
  unit: u,
  placeholder,
  className,
  onCommit,
}: {
  value: string
  unit?: string
  placeholder?: string
  className?: string
  onCommit: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(value)
  }
  return (
    <label className={cn(fieldCls, className)}>
      <input
        className="w-full min-w-0 bg-transparent font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onCommit(draft)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      {u && <span className={unitCls}>{u}</span>}
    </label>
  )
}

export function SelectField<T extends string>({
  value,
  options,
  className,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  className?: string
  onChange: (v: T) => void
}) {
  return (
    <span className={cn(fieldCls, 'relative font-sans text-[11.5px]', className)}>
      <select
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
    <div className="flex h-6 flex-1 overflow-hidden rounded-md border border-line">
      {[true, false].map((on, i) => (
        <button
          key={labels[i]}
          type="button"
          aria-pressed={value === on}
          className={cn(
            'flex-1 text-[11px] text-ink-soft transition-colors hover:text-ink',
            value === on && 'bg-ink font-semibold text-white hover:text-white',
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
  className,
  onCommit,
}: {
  value: string | null
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
          aria-label="Pick colour"
          className="absolute -inset-1 cursor-pointer opacity-0"
          value={value ?? '#ffffff'}
          onChange={(e) => onCommit(e.target.value)}
        />
      </span>
      <input
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
