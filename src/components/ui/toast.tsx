import * as React from 'react'

import { cn } from '@/lib/utils'

/* The dark pill that confirms something happened. It sits above the safe area
   and stays clear of the canvas toolbar on phones. */
function Toast({ className, children, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="toast"
      role="status"
      aria-live="polite"
      className={cn(
        'fixed bottom-[calc(76px+env(safe-area-inset-bottom))] left-1/2 z-[70] flex -translate-x-1/2 items-center gap-3 rounded-[10px] bg-ink px-4 py-2.5 text-body/4 font-semibold text-paper shadow-pop animate-[chip-in_0.2s_ease] sm:bottom-5 sm:left-auto sm:right-5 sm:translate-x-0',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

/** The inverted button inside a toast (“Reload”). */
function ToastAction({ className, ...props }: React.ComponentProps<'button'>) {
  return (
    <button
      type="button"
      data-slot="toast-action"
      className={cn(
        'rounded-[7px] border-0 bg-paper px-2.5 py-1 text-body/4 font-bold text-ink transition-opacity hover:opacity-90',
        className,
      )}
      {...props}
    />
  )
}

/** A ring turning while something runs, in the colour of the text around
 *  it (a busy button). */
function Spinner({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="spinner"
      aria-hidden
      className={cn(
        'size-3.5 shrink-0 animate-spin rounded-full border-2 border-current/30 border-t-current',
        className,
      )}
      {...props}
    />
  )
}

/** Leads a toast whose action is still running (an export rendering). */
function ToastSpinner({ className, ...props }: React.ComponentProps<'span'>) {
  return <Spinner data-slot="toast-spinner" className={cn('border-paper/30 border-t-paper', className)} {...props} />
}

export { Spinner, Toast, ToastAction, ToastSpinner }
