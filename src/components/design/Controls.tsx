import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { ResetIcon } from '../ui/icons'
import type { DesignProperty } from '../../lib/designProperties'

/* The styling panel speaks in the chrome voice: 24px mono fields on a hairline,
   labels to the left of their control, one property per row. */
export const selectClass =
  'h-6 w-full min-w-0 rounded-md border border-line bg-surface px-[7px] font-mono text-[11px] text-ink outline-none focus:border-ink disabled:opacity-50 max-md:h-9'

const fieldClass = 'h-6 min-w-0 rounded-md border-line px-[7px] font-mono text-[11px] focus:border-ink max-md:h-9'

/** Panel-level shortcut chip: `Esc`, `Shift 1`. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-block rounded-[5px] border border-line bg-paper px-1 font-mono text-[9.5px] font-normal leading-[15px] text-ink-soft">
      {children}
    </kbd>
  )
}

/** Label on the left, control on the right — the row every property uses. */
export function FieldRow({
  label,
  htmlFor,
  className,
  children,
}: {
  label: ReactNode
  htmlFor?: string
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn('grid min-h-[26px] grid-cols-[58px_1fr] items-center gap-1.5', className)}>
      <label htmlFor={htmlFor} className="truncate text-[11px] text-ink-soft">
        {label}
      </label>
      <div className="flex min-w-0 items-center gap-1">{children}</div>
    </div>
  )
}

export function DesignSection({
  id,
  title,
  defaultOpen = false,
  children,
}: {
  id: string
  title: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(`doop:design:${id}`)
      return saved === null ? defaultOpen : saved === '1'
    } catch {
      return defaultOpen
    }
  })
  return (
    <Collapsible
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        try {
          localStorage.setItem(`doop:design:${id}`, value ? '1' : '0')
        } catch {
          /* unavailable storage */
        }
      }}
      className="border-b border-line-soft"
    >
      <CollapsibleTrigger
        aria-label={title}
        className="group flex h-9 w-full items-center gap-2 px-3 text-left text-[11.5px] font-bold text-ink hover:bg-paper/60"
      >
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-1 px-3 pb-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** A field commits once (blur/Enter), cancels with Escape, and never loses a
 * dirty draft when a computed-style response arrives while it is focused. */
export function DesignInput({
  label,
  value,
  onCommit,
  multiline = false,
  className,
  placeholder,
  id,
}: {
  label: string
  value: string
  onCommit(value: string): void
  multiline?: boolean
  className?: string
  placeholder?: string
  id?: string
}) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  const original = useRef(value)
  const cancelled = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])
  const props = {
    id,
    'aria-label': label,
    value: draft,
    placeholder,
    onFocus: () => {
      focused.current = true
      original.current = value
      cancelled.current = false
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: () => {
      focused.current = false
      if (!cancelled.current && draft !== original.current) onCommit(draft)
      else setDraft(value)
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        cancelled.current = true
        setDraft(value)
        e.currentTarget.blur()
      }
      if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        e.currentTarget.blur()
      }
      if (!multiline && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const numeric = draft.match(/^(-?(?:\d+\.?\d*|\.\d+))(px|%|em|rem|deg)?$/)
        if (numeric) {
          e.preventDefault()
          setDraft(
            `${Math.round((Number(numeric[1]) + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)) * 1000) / 1000}${numeric[2] || ''}`,
          )
        }
      }
    },
  }
  return multiline ? (
    <textarea {...props} className={cn(selectClass, 'h-16 resize-y py-1.5 leading-relaxed', className)} />
  ) : (
    <Input {...props} variant="mono" inputSize="sm" className={cn(fieldClass, className)} />
  )
}

function toHex(color: string): string {
  if (/^#[\da-f]{6}$/i.test(color)) return color
  const short = color.match(/^#([\da-f])([\da-f])([\da-f])$/i)
  if (short) return `#${short[1].repeat(2)}${short[2].repeat(2)}${short[3].repeat(2)}`
  const rgb = color.match(/^rgba?\((\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/)
  return rgb
    ? `#${rgb
        .slice(1, 4)
        .map((n) => Number(n).toString(16).padStart(2, '0'))
        .join('')}`
    : '#000000'
}

export function PropertyField({
  field,
  authored,
  computed,
  onCommit,
}: {
  field: DesignProperty
  authored: string
  computed: string
  onCommit(property: string, value: string): void
}) {
  const id = useId()
  const value = authored || computed
  return (
    <FieldRow label={field.label} htmlFor={id}>
      {field.color && (
        <input
          type="color"
          aria-label={`Pick ${field.label}`}
          defaultValue={toHex(computed || authored)}
          key={computed || authored}
          className="size-6 shrink-0 cursor-pointer rounded-md border border-line bg-surface p-0.5 max-md:size-9"
          onBlur={(e) => {
            if (e.target.value !== toHex(computed || authored)) onCommit(field.key, e.target.value)
          }}
        />
      )}
      {field.options ? (
        <select
          id={id}
          aria-label={field.label}
          className={selectClass}
          value={value}
          onChange={(e) => onCommit(field.key, e.target.value)}
        >
          {!field.options.includes(value) && <option value={value}>{value || 'Default'}</option>}
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : field.unit ? (
        <UnitInput id={id} field={field} value={value} onCommit={(next) => onCommit(field.key, next)} />
      ) : (
        <DesignInput
          id={id}
          label={field.label}
          value={value}
          placeholder="Default"
          onCommit={(next) => onCommit(field.key, next)}
        />
      )}
      {authored && (
        <button
          type="button"
          className="grid size-5 shrink-0 place-items-center rounded text-ink-faint hover:bg-paper-deep hover:text-ink"
          aria-label={`Reset ${field.label}`}
          title="Remove inline override"
          onClick={() => onCommit(field.key, '')}
        >
          <ResetIcon className="size-3" />
        </button>
      )}
    </FieldRow>
  )
}

/** `236` in the field, `px` as a quiet suffix — the unit is not part of the
 * text. A bare number typed in gets the unit back on commit; anything else
 * (`auto`, `100%`, `calc(...)`) passes through untouched. */
function UnitInput({
  id,
  field,
  value,
  onCommit,
}: {
  id: string
  field: DesignProperty
  value: string
  onCommit(value: string): void
}) {
  const unit = field.unit!
  const match = value.match(new RegExp(`^(-?(?:\\d+\\.?\\d*|\\.\\d+))${unit}$`))
  const shown = match ? match[1] : value
  return (
    <div className="relative min-w-0 flex-1">
      <DesignInput
        id={id}
        label={field.label}
        value={shown}
        placeholder="Default"
        className={cn((match || !value) && 'pr-7')}
        onCommit={(next) => onCommit(/^-?(?:\d+\.?\d*|\.\d+)$/.test(next.trim()) ? `${next.trim()}${unit}` : next)}
      />
      {(match || !value) && (
        <span className="pointer-events-none absolute top-1/2 right-[7px] -translate-y-1/2 font-mono text-[9.5px] text-ink-faint">
          {unit}
        </span>
      )}
    </div>
  )
}

export function SmallAction({ children, className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button size="sm" className={cn('h-7 flex-1 gap-1.5 px-2 text-[11px]', className)} {...props}>
      {children}
    </Button>
  )
}
