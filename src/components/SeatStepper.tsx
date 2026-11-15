import { useState } from 'react'
import { MAX_SEATS } from '../../shared/billing'
import { useT } from '../lib/i18n'
import { IconButton } from './ui/icon-button'
import { MinusIcon, PlusIcon } from './ui/icons'
import { Input } from './ui/input'

/** How many seats to pay for: − and + around a field that also takes a
 *  typed number. Never below `min` (the people already in the workspace),
 *  never past MAX_SEATS. */
export function SeatStepper({
  value,
  min,
  disabled,
  onChange,
}: {
  value: number
  min: number
  disabled?: boolean
  onChange: (seats: number) => void
}) {
  const t = useT()
  /* what is typed, until it is a number in range */
  const [draft, setDraft] = useState<string | null>(null)
  const clamp = (n: number) => Math.min(MAX_SEATS, Math.max(min, n))

  function commit() {
    if (draft === null) return
    const n = Number.parseInt(draft, 10)
    if (Number.isFinite(n)) onChange(clamp(n))
    setDraft(null)
  }

  return (
    <span className="inline-flex items-center gap-1">
      <IconButton
        size="sm"
        aria-label={t('plans.fewerSeats')}
        disabled={disabled || value <= min}
        onClick={() => onChange(clamp(value - 1))}
      >
        <MinusIcon size="rail" />
      </IconButton>
      <Input
        className="h-7 w-12 px-1 text-center tabular-nums"
        inputMode="numeric"
        aria-label={t('plans.seatCount')}
        disabled={disabled}
        value={draft ?? String(value)}
        onChange={(event) => setDraft(event.target.value.replace(/\D/g, ''))}
        onBlur={commit}
        onKeyDown={(event) => event.key === 'Enter' && commit()}
      />
      <IconButton
        size="sm"
        aria-label={t('plans.moreSeats')}
        disabled={disabled || value >= MAX_SEATS}
        onClick={() => onChange(clamp(value + 1))}
      >
        <PlusIcon size="rail" />
      </IconButton>
    </span>
  )
}
