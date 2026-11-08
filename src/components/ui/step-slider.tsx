import * as React from 'react'

import { cn } from '@/lib/utils'

/* A pick from a short ordered scale (reasoning effort): the chosen step
   named above, a pill track filled up to a round thumb, a dot at every step.
   A native range input lies over the track, so dragging, clicking a step,
   the arrow keys and screen readers all work as for any slider; its keys are
   kept from a surrounding menu, which would otherwise take the arrows. While
   a drag or a key is held the step lives here only, and `onValueChange` runs
   once, on release: a save per step passed re-rendered the menu mid-drag.
   A save that returns a promise keeps the picked step showing until it
   settles; dropping it on release flashed the old step back for the length
   of the round trip. The slider holds still meanwhile, so a second pick can
   never be shown and then lost when the first save lands. */

/* the thumb stands proud of the track, so no edge of the fill shows around it */
const TRACK = 28
const THUMB = 34

function StepSlider({
  steps,
  value,
  onValueChange,
  label,
  className,
}: {
  steps: { id: string; name: string; title?: string }[]
  value: string | undefined
  /** a promise holds the pick on screen until the save settles */
  onValueChange: (id: string) => void | Promise<unknown>
  /** names the slider for assistive tech */
  label: string
  className?: string
}) {
  const found = steps.findIndex((step) => step.id === value)
  const saved = found < 0 ? 0 : found
  /* the step under a drag or a held key, then while its save is under way */
  const [draft, setDraft] = React.useState<number | null>(null)
  const [saving, setSaving] = React.useState(false)
  const index = draft ?? saved
  const commit = () => {
    if (draft === null || saving) return
    const next = steps[draft]
    if (!next || draft === saved) {
      setDraft(null)
      return
    }
    const pending = onValueChange(next.id)
    if (!pending) {
      setDraft(null)
      return
    }
    setSaving(true)
    /* settled either way: on success `value` is the pick, on failure the old one */
    void Promise.resolve(pending)
      .catch(() => {})
      .finally(() => {
        setSaving(false)
        setDraft(null)
      })
  }
  const last = Math.max(steps.length - 1, 1)
  /* a step's centre: the track less half a thumb at each end */
  const at = (i: number) => `calc(${THUMB / 2}px + (100% - ${THUMB}px) * ${i / last})`
  const current = steps[index]
  return (
    <div data-slot="step-slider" className={cn('flex flex-col items-center gap-2', className)}>
      <span className="text-body font-medium text-brand" aria-hidden title={current?.title}>
        {current?.name}
      </span>
      <div className="relative w-full rounded-full bg-paper-deep" style={{ height: TRACK }}>
        {/* to the thumb's centre, the thumb covering its end; the first step
            has nothing to fill, and a fill there peeked round the thumb */}
        {index > 0 && (
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 rounded-full bg-brand transition-[width] duration-150"
            style={{ width: at(index) }}
          />
        )}
        {steps.map((step, i) => (
          <span
            key={step.id}
            aria-hidden
            className={cn(
              'absolute top-1/2 size-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full',
              i < index ? 'bg-white/70' : 'bg-ink-faint',
              i === index && 'hidden',
            )}
            style={{ left: at(i) }}
          />
        ))}
        <span
          aria-hidden
          className="absolute top-1/2 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,.3)] transition-[left] duration-150"
          style={{ width: THUMB, height: THUMB, left: at(index), transform: 'translate(-50%, -50%)' }}
        />
        <input
          type="range"
          min={0}
          max={steps.length - 1}
          step={1}
          value={index}
          aria-label={label}
          aria-valuetext={current?.name}
          disabled={saving}
          aria-busy={saving}
          className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-progress"
          onChange={(e) => setDraft(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </div>
    </div>
  )
}

export { StepSlider }
