import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/* Cards draw at the 10px pill step, a notch inside the 12px tile corner
   (rounded-card) the home and gallery tiles use. */
const cardVariants = cva('min-w-0 bg-surface', {
  variants: {
    tone: {
      /* a resting surface: squircle corners, no drawn border — the edge is
         the half-pixel ring inside the elevation shadow */
      default: 'rounded-pill corner-squircle shadow-elevation-1',
      /* settings/admin sections: a flat panel that groups rows */
      flat: 'rounded-pill border border-line',
      /* clickable tiles (canvas cards): the shadow deepens on hover — the
         lift is under the card, nothing is redrawn */
      raised:
        'rounded-pill corner-squircle shadow-elevation-1 transition-[box-shadow] duration-normal ease-out-quad hover:shadow-elevation-1-hover',
      /* an empty state's placeholder: a dashed outline on the paper, no surface */
      dashed: 'rounded-pill border-[1.5px] border-dashed border-line bg-transparent',
    },
    /* `hero` is the generous corner of the one card on an otherwise empty page */
    shape: { default: '', hero: 'rounded-[18px]' },
  },
  defaultVariants: { tone: 'default', shape: 'default' },
})

function Card({ className, tone, shape, ...props }: React.ComponentProps<'div'> & VariantProps<typeof cardVariants>) {
  return <div data-slot="card" className={cn(cardVariants({ tone, shape, className }))} {...props} />
}

/** A section of a settings pane (Settings, Workspace): a Card at the settings
 *  column's width, spaced from the section above it, clipping its rows to its
 *  corners. A component rather than a `Card` variant because this is page
 *  layout, not a look: it takes every `tone` (the danger zone is
 *  `<SettingsCard tone="flat">`), and `Card` itself stays free of outer margins. */
function SettingsCard({ className, ...props }: React.ComponentProps<typeof Card>) {
  return (
    <Card
      data-slot="settings-card"
      className={cn('mt-4 max-w-[1000px] overflow-hidden sm:mt-5', className)}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn('border-b border-line-soft px-4 pb-[15px] pt-[17px] sm:px-[22px] sm:pb-4 sm:pt-[18px]', className)}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  return (
    <h2
      data-slot="card-title"
      className={cn('text-lead font-medium tracking-[-0.01em] text-ink', className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="card-description"
      className={cn('mt-1.5 max-w-[62em] text-body text-ink-soft', className)}
      {...props}
    />
  )
}

function CardBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-body" className={cn('px-4 py-4 sm:px-5', className)} {...props} />
}

/* The field a row edits sits at a fixed width from sm up, so the fields of one
   card line up; on phones the row is one column and the field fills it. */
const cardControlWidths = {
  /* a name, a password */
  md: 'sm:w-[280px]',
  /* a URL */
  lg: 'sm:w-[420px]',
} as const

/** A labelled row inside a settings card: label, field, trailing action. The
 *  three columns stack into one on phones, where the label reads as a heading
 *  over its field rather than a column beside it. `control` is the row's field
 *  (an Input), sized by `controlWidth`; `children` follow it: notes, errors, or
 *  the row's whole content when it edits nothing. */
function CardRow({
  label,
  action,
  control,
  controlWidth = 'md',
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  label?: React.ReactNode
  action?: React.ReactNode
  control?: React.ReactNode
  controlWidth?: keyof typeof cardControlWidths
}) {
  return (
    <div
      data-slot="card-row"
      className={cn(
        'flex flex-col items-stretch gap-2 border-b border-line-soft px-4 py-[15px] last:border-b-0 sm:flex-row sm:items-center sm:gap-[14px] sm:px-[22px] sm:py-[14px]',
        className,
      )}
      {...props}
    >
      {label ? (
        <span className="flex-none text-body font-medium text-ink-soft sm:w-[150px] sm:font-normal sm:text-ink-faint">
          {label}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
        {control ? (
          <span
            data-slot="card-control"
            className={cn('flex w-full min-w-0 flex-none', cardControlWidths[controlWidth])}
          >
            {control}
          </span>
        ) : null}
        {children}
      </span>
      {action ? <span className="flex flex-wrap items-center justify-start gap-2.5 sm:ml-auto">{action}</span> : null}
    </div>
  )
}

export { Card, SettingsCard, CardHeader, CardTitle, CardDescription, CardBody, CardRow, cardVariants }
