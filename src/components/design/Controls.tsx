import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import type { DesignProperty } from '../../lib/designProperties'

export const selectClass =
  'h-8 w-full min-w-0 rounded-md border border-line bg-surface px-2 text-[11px] text-ink outline-none focus:border-brand focus:ring-1 focus:ring-brand disabled:opacity-50 max-md:h-10'

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
        className="group flex w-full items-center gap-2 px-3.5 py-3 text-left text-xs font-semibold text-ink hover:bg-paper/60"
      >
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid grid-cols-2 gap-x-2 gap-y-2.5 px-3.5 pb-3.5">{children}</div>
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
    <textarea {...props} className={cn(selectClass, 'h-20 resize-y py-2 font-mono leading-relaxed', className)} />
  ) : (
    <Input {...props} inputSize="sm" className={cn('h-8 min-w-0 font-mono text-[11px] max-md:h-10', className)} />
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
    <div className={cn('min-w-0', field.wide && 'col-span-2')}>
      <div className="mb-1 flex h-4 items-center justify-between gap-1">
        <label htmlFor={id} className="truncate text-[10px] text-ink-soft">
          {field.label}
        </label>
        {authored && (
          <button
            type="button"
            className="rounded px-1 text-[10px] text-ink-faint hover:bg-paper-deep hover:text-ink"
            aria-label={`Reset ${field.label}`}
            title="Remove inline override"
            onClick={() => onCommit(field.key, '')}
          >
            ↺
          </button>
        )}
      </div>
      <div className="flex min-w-0 gap-1.5">
        {field.color && (
          <input
            type="color"
            aria-label={`Pick ${field.label}`}
            defaultValue={toHex(computed || authored)}
            key={computed || authored}
            className="h-8 w-8 shrink-0 cursor-pointer rounded-md border border-line bg-surface p-0.5 max-md:h-10 max-md:w-10"
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
        ) : (
          <DesignInput
            id={id}
            label={field.label}
            value={value}
            placeholder="Default"
            onCommit={(next) => onCommit(field.key, next)}
          />
        )}
      </div>
    </div>
  )
}

export function SmallAction({ children, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button variant="ghost" size="sm" className="min-h-8 flex-1 px-2 text-[11px]" {...props}>
      {children}
    </Button>
  )
}
