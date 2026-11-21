import { useState } from 'react'
import { api, errorMessage, type LibraryUpdateReport } from '../lib/api'
import { useT } from '../lib/i18n'
import { useStore } from '../lib/store'
import { ConfirmDialog } from './ui/alert-dialog'
import { Button } from './ui/button'

/**
 * "Update everywhere": pull a library's latest publication into every canvas
 * of the workspace using it. Publishing never does this, so it is its own
 * button behind a confirmation that says how many canvases it reaches and what
 * happens to their approved frames, and it reports what it did.
 * Spec: .context/specs/workspace-component-library.md.
 */
export function UpdateEverywhereButton({
  canvasId,
  count,
  variant,
  className,
  onDone,
  onNotice,
}: {
  /** the library canvas */
  canvasId: string
  /** canvases on an older version, as the caller last read it */
  count: number
  variant?: 'brand'
  className?: string
  onDone?: (report: LibraryUpdateReport) => void
  /** where the outcome is said, on a page without the canvas's notices (the Workspace page's toast) */
  onNotice?: (text: string) => void
}) {
  const t = useT()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const notice = (text: string) => (onNotice ? onNotice(text) : useStore.getState().pushNotice(text))

  const summary = (report: LibraryUpdateReport) => {
    const review = report.canvases.reduce((total, canvas) => total + canvas.approvals_withdrawn, 0)
    if (!report.canvases.length && !report.skipped.length) return t('components.libraryEverywhereNone')
    return [
      t('components.libraryEverywhereDone', { count: report.canvases.length }),
      ...(review ? [t('components.libraryEverywhereReview', { count: review })] : []),
      ...(report.skipped.length ? [t('components.libraryEverywhereSkipped', { count: report.skipped.length })] : []),
    ].join(' · ')
  }

  const run = async () => {
    setBusy(true)
    try {
      const report = await api.updateLibraryEverywhere(canvasId)
      notice(summary(report))
      onDone?.(report)
    } catch (error) {
      notice(errorMessage(error, t('components.libraryEverywhereFailed')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant={variant}
        className={className}
        disabled={busy}
        onClick={() => setAsking(true)}
        data-library-update-everywhere
      >
        {busy ? t('components.libraryUpdating') : t('components.libraryEverywhere')}
      </Button>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={t('components.libraryEverywhereTitle', { count })}
        description={t('components.libraryEverywhereBody')}
        confirmLabel={t('components.libraryEverywhere')}
        onConfirm={() => void run()}
      />
    </>
  )
}
