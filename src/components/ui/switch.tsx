import * as React from 'react'
import { cn } from '@/lib/utils'

export interface SwitchProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  thumbClassName?: string
}

/**
 * An accessible toggle switch component following Doop's visual identity.
 * Features a rounded track with sliding thumb, smooth transitions, and distinct focus ring.
 */
const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  (
    {
      className,
      thumbClassName,
      checked: controlledChecked,
      defaultChecked = false,
      onCheckedChange,
      disabled,
      onClick,
      onKeyDown,
      ...props
    },
    ref,
  ) => {
    const [uncontrolledChecked, setUncontrolledChecked] = React.useState(defaultChecked)
    const isControlled = controlledChecked !== undefined
    const isChecked = isControlled ? controlledChecked : uncontrolledChecked

    const toggle = () => {
      if (disabled) return
      const nextChecked = !isChecked
      if (!isControlled) {
        setUncontrolledChecked(nextChecked)
      }
      onCheckedChange?.(nextChecked)
    }

    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={isChecked}
        disabled={disabled}
        data-state={isChecked ? 'checked' : 'unchecked'}
        onClick={(e) => {
          toggle()
          onClick?.(e)
        }}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault()
            toggle()
          }
          onKeyDown?.(e)
        }}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-normal ease-out-quad',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
          'disabled:cursor-not-allowed disabled:opacity-50',
          isChecked
            ? 'border-ink bg-ink hover:border-ink hover:bg-ink'
            : 'border-line bg-paper-deep hover:border-ink-faint',
          className,
        )}
        {...props}
      >
        <span
          data-slot="switch-thumb"
          aria-hidden="true"
          className={cn(
            'pointer-events-none block size-5 rounded-full shadow-sm transition-[transform,background-color] duration-normal ease-out-quad',
            isChecked ? 'translate-x-[21px] bg-paper' : 'translate-x-[1px] bg-surface dark:bg-ink-soft',
            thumbClassName,
          )}
        />
      </button>
    )
  },
)
Switch.displayName = 'Switch'

/**
 * A labelled row with title, description, and Switch on the right side.
 * Ideal for grouping within a Card.
 */
function SwitchRow({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  icon,
  className,
}: {
  label: React.ReactNode
  description?: React.ReactNode
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  icon?: React.ReactNode
  className?: string
}) {
  return (
    <div
      data-slot="switch-row"
      className={cn(
        'flex items-center justify-between gap-4 border-b border-line-soft px-4 py-[15px] last:border-b-0 sm:px-[22px] sm:py-[16px]',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {icon ? <div className="mt-0.5 flex-none text-ink-soft">{icon}</div> : null}
        <div className="flex flex-col">
          <span className="text-[13.5px] font-semibold text-ink sm:text-[13px]">{label}</span>
          {description ? <span className="mt-0.5 text-xs leading-[1.4] text-ink-soft">{description}</span> : null}
        </div>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-label={typeof label === 'string' ? label : undefined}
      />
    </div>
  )
}

/**
 * An interactive card with title, description, and Switch.
 * Clicking anywhere on the card toggles the switch.
 */
function SwitchCard({
  checked,
  disabled,
  onChange,
  title,
  description,
  icon,
  className,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  icon?: React.ReactNode
  className?: string
}) {
  return (
    <div
      role="button"
      tabIndex={disabled ? undefined : 0}
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!checked)
      }}
      onKeyDown={(e) => {
        if (!disabled && (e.key === ' ' || e.key === 'Enter')) {
          e.preventDefault()
          onChange(!checked)
        }
      }}
      className={cn(
        'relative mt-3.5 flex cursor-pointer select-none items-start justify-between gap-4 rounded-[11px] border border-line bg-surface p-[15px] transition-[border-color,background] hover:border-ink-faint',
        checked &&
          'border-ink hover:border-ink [background:linear-gradient(110deg,rgba(39,67,238,0.05),transparent_72%),var(--surface)]',
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {icon ? <div className="mt-0.5 flex-none text-ink-soft">{icon}</div> : null}
        <div>
          <span className="block text-[13.5px] font-bold text-ink">{title}</span>
          {description ? <span className="mt-1 block text-xs leading-[1.4] text-ink-soft">{description}</span> : null}
        </div>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      />
    </div>
  )
}

export { Switch, SwitchRow, SwitchCard }
