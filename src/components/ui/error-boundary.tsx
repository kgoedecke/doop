import * as React from 'react'

import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { captureCaughtError } from '@/lib/posthog'

import { Button } from './button'
import { AlertIcon } from './icons'

interface ErrorBoundaryProps {
  children?: React.ReactNode
  /** a change here clears the failure and mounts the area again (a new
   *  version of the frame that failed) */
  resetKey?: unknown
  /** draws the fallback in the failed area's place; given Retry. Unset, it
   *  floats at the foot of the window. */
  fallback?: (retry: () => void) => React.ReactNode
}

/* A render error unmounts everything up to the nearest boundary, so without
   one a throw anywhere blanks the whole page. A boundary keeps the failure to
   its own area, which offers Retry, and reports it: the unhandled-error
   autocapture never sees an error React caught. A class, because
   getDerivedStateFromError has no hook. */
class ErrorBoundary extends React.Component<ErrorBoundaryProps, { error: Error | null }> {
  override state = { error: null as Error | null }
  /* the failure already reported, so one that repeats on every retry (a
     frame broken while an agent streams into it) is reported once */
  private reported: string | null = null

  static getDerivedStateFromError(thrown: unknown) {
    return { error: thrown instanceof Error ? thrown : new Error(String(thrown)) }
  }

  override componentDidCatch(error: Error, { componentStack }: React.ErrorInfo) {
    /* the stack's first line names the component that threw */
    const component = componentStack?.match(/at (\w+)/)?.[1] ?? 'unknown'
    console.error(`[${component}] failed to render`, error, componentStack)
    const signature = `${component} ${error.name}: ${error.message}`
    if (signature === this.reported) return
    this.reported = signature
    captureCaughtError(error, { error_component: component, component_stack: componentStack ?? undefined })
  }

  override componentDidUpdate(prev: ErrorBoundaryProps, prevState: { error: Error | null }) {
    /* only a failure already showing retries on a new key: one that arrived
       with the key change would just fail again */
    if (prevState.error && this.state.error && !Object.is(prev.resetKey, this.props.resetKey)) this.retry()
  }

  retry = () => this.setState({ error: null })

  override render() {
    if (!this.state.error) return this.props.children
    /* with no place of its own, the fallback floats at the foot of the window */
    return this.props.fallback ? (
      this.props.fallback(this.retry)
    ) : (
      <ErrorFallback retry={this.retry} className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2" />
    )
  }
}

/** What a failed area shows in its place: a failure mark, one line saying it
 *  could not be shown, and Retry. */
function ErrorFallback({ retry, className }: { retry: () => void; className?: string }) {
  const t = useT()
  return (
    <div
      role="alert"
      data-slot="error-fallback"
      className={cn(
        'pointer-events-auto flex items-center gap-2 rounded-control bg-surface bg-linear-to-r from-accent-ink/8 to-accent-ink/8 py-1.5 pr-1.5 pl-2.5 text-body text-ink shadow-ring',
        className,
      )}
    >
      <AlertIcon size="rail" className="shrink-0 text-accent-ink" />
      <span className="min-w-0 flex-1 truncate">{t('ui.errorTitle')}</span>
      <Button size="sm" variant="ghost" onClick={retry}>
        {t('ui.errorRetry')}
      </Button>
    </div>
  )
}

export { ErrorBoundary, ErrorFallback }
