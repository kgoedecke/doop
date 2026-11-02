import * as React from 'react'

import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { Disclosure } from './collapsible'
import { Note } from './note'

/* The one-click install every agent connection offers (Codex, Claude Desktop,
   Cursor): the primary action, a line under it saying how it went or what it
   needs, the failure when there is one, and the manual steps folded away
   beneath (a Disclosure, mounted while folded). */
function InstallBlock({
  action,
  status,
  error,
  manual,
  manualLabel,
  className,
}: {
  /** the button or link that installs, or a sentence when this setup cannot */
  action: React.ReactNode
  /** progress, the confirmation, or what the action needs; announced politely */
  status?: React.ReactNode
  /** why the action failed; announced at once */
  error?: React.ReactNode
  /** the fallback steps, collapsed until asked for */
  manual?: React.ReactNode
  manualLabel?: React.ReactNode
  className?: string
}) {
  const t = useT()
  return (
    <div data-slot="install-block" className={cn('mt-2.5 text-label leading-relaxed text-ink-soft', className)}>
      {action}
      {status && (
        <p className="mt-2" role="status">
          {status}
        </p>
      )}
      {error && (
        <Note tone="error" size="sm" role="alert" className="mt-2 block">
          {error}
        </Note>
      )}
      {manual && (
        <Disclosure label={manualLabel ?? t('ui.setUpManually')} className="mt-3">
          {manual}
        </Disclosure>
      )}
    </div>
  )
}

export { InstallBlock }
