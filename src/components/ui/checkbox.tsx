import * as React from 'react'

import { cn } from '@/lib/utils'

/* A checkbox drawn as a square that fills with ink when checked. The real
   input stays in the DOM (visually hidden, not display:none) so the control
   keeps native keyboard behaviour and form semantics; `peer-focus-visible`
   draws the focus ring on the square. */
function Checkbox({ className, boxClassName, ...props }: React.ComponentProps<'input'> & { boxClassName?: string }) {
  return (
    <>
      <input
        type="checkbox"
        data-slot="checkbox"
        className={cn('peer pointer-events-none absolute opacity-0', className)}
        {...props}
      />
      <span
        aria-hidden="true"
        className={cn(
          'grid size-5 flex-none place-items-center rounded-[5px] border border-ink-faint bg-surface text-xs font-extrabold text-paper transition-colors peer-checked:border-ink peer-checked:bg-ink peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand peer-disabled:opacity-50',
          boxClassName,
        )}
      >
        {props.checked ? '✓' : ''}
      </span>
    </>
  )
}

/** A checkbox with a title and supporting copy, framed as a selectable card. */
function CheckboxCard({
  checked,
  disabled,
  onChange,
  title,
  description,
  className,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  className?: string
}) {
  return (
    <label
      className={cn(
        'relative mt-3.5 grid cursor-pointer grid-cols-[22px_1fr] items-start gap-3 rounded-[11px] border border-line bg-surface p-[15px] transition-[border-color,background] hover:border-ink-faint',
        checked &&
          'border-ink hover:border-ink [background:linear-gradient(110deg,rgba(39,67,238,0.05),transparent_72%),var(--surface)]',
        className,
      )}
    >
      <Checkbox checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-[13.5px] font-bold text-ink">{title}</span>
        {description ? <span className="mt-1 block text-xs leading-[1.4] text-ink-soft">{description}</span> : null}
      </span>
    </label>
  )
}

export { Checkbox, CheckboxCard }
