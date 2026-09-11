import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const cardVariants = cva('min-w-0 bg-surface', {
  variants: {
    tone: {
      /* a resting surface: squircle corners, no drawn border — the edge is
         the half-pixel ring inside the elevation shadow */
      default: 'rounded-[10px] corner-squircle shadow-elevation-1',
      /* settings/admin sections: a flat panel that groups rows */
      flat: 'rounded-[10px] border border-line',
      /* clickable tiles (canvas cards): the shadow deepens on hover — the
         lift is under the card, nothing is redrawn */
      raised:
        'rounded-[10px] corner-squircle shadow-elevation-1 transition-[box-shadow] duration-normal ease-out-quad hover:shadow-elevation-1-hover',
    },
  },
  defaultVariants: { tone: 'default' },
})

function Card({ className, tone, ...props }: React.ComponentProps<'div'> & VariantProps<typeof cardVariants>) {
  return <div data-slot="card" className={cn(cardVariants({ tone, className }))} {...props} />
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
      className={cn('font-display text-[17px] font-extrabold tracking-[-0.02em] text-ink', className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="card-description"
      className={cn('mt-[7px] max-w-[62em] text-[13px] leading-[1.55] text-ink-soft', className)}
      {...props}
    />
  )
}

function CardBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-body" className={cn('px-4 py-4 sm:px-5', className)} {...props} />
}

/** A labelled row inside a settings card: label, field, trailing action. The
 *  three columns stack into one on phones, where the label reads as a heading
 *  over its field rather than a column beside it. */
function CardRow({
  label,
  action,
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & { label?: React.ReactNode; action?: React.ReactNode }) {
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
        <span className="flex-none text-[12.5px] font-semibold text-ink-soft sm:w-[150px] sm:font-normal sm:text-ink-faint">
          {label}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">{children}</span>
      {action ? <span className="flex flex-wrap items-center justify-start gap-2.5 sm:ml-auto">{action}</span> : null}
    </div>
  )
}

export { Card, CardHeader, CardTitle, CardDescription, CardBody, CardRow, cardVariants }
