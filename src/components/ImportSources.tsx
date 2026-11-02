import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { ArrowLeftIcon, ArrowRightIcon } from './ui/icons'
import { ModalLede, ModalTitle } from './ui/modal'
import { useT } from '@/lib/i18n'

/**
 * The import modal's two-step chrome: a picker of source cards, then one
 * screen per source. Each screen shares the same bones — an icon tile
 * beside the serif title, a lede, the source's own body, and a footer of
 * fine print with Back and the primary action.
 */

export interface ImportSource {
  id: string
  title: string
  blurb: string
  icon: ReactNode
  /** greyed out with a "Soon" tag; the card does not navigate */
  soon?: boolean
}

export function SourcePicker({ sources, onPick }: { sources: ImportSource[]; onPick: (id: string) => void }) {
  const t = useT()
  return (
    <>
      <ModalTitle>{t('panels.importTitle')}</ModalTitle>
      <ModalLede>{t('panels.importLede')}</ModalLede>
      <div className="mt-6 grid grid-cols-1 gap-3 xs:grid-cols-2 md:grid-cols-3">
        {sources.map((source) => (
          <button
            key={source.id}
            type="button"
            disabled={source.soon}
            className={cn(
              'group relative flex min-h-[140px] flex-col rounded-xl border border-line bg-surface p-4 pt-[18px] text-left shadow-card outline-none transition-[transform,box-shadow,border-color]',
              source.soon
                ? 'opacity-60'
                : 'hover:-translate-y-[3px] hover:border-ink-faint hover:shadow-pop focus-visible:-translate-y-[3px] focus-visible:border-ink-faint focus-visible:shadow-pop',
            )}
            onClick={() => !source.soon && onPick(source.id)}
          >
            <span className="flex size-10 items-center justify-center overflow-hidden rounded-pill border border-line bg-surface">
              {source.icon}
            </span>
            <b className="mt-4 text-lead font-semibold tracking-[-0.012em]">{source.title}</b>
            <span className="mt-1 text-body leading-[1.45] text-ink-soft">{source.blurb}</span>
            {source.soon ? (
              <span className="absolute right-4 top-4 text-caption text-ink-faint">{t('panels.importSoon')}</span>
            ) : (
              <span className="absolute bottom-3.5 right-4 text-accent-ink opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                <ArrowRightIcon className="size-4" />
              </span>
            )}
          </button>
        ))}
      </div>
    </>
  )
}

export function ImportStepHeader({ icon, title }: { icon: ReactNode; title: ReactNode }) {
  return (
    <div className="flex items-center gap-3.5">
      <span className="flex size-11 flex-none items-center justify-center overflow-hidden rounded-[11px] border border-line bg-surface">
        {icon}
      </span>
      <ModalTitle>{title}</ModalTitle>
    </div>
  )
}

/** Fine print on the left, Back beside the screen's primary action. */
export function ImportStepFooter({
  note,
  onBack,
  backDisabled,
  children,
}: {
  note?: ReactNode
  onBack: () => void
  backDisabled?: boolean
  children?: ReactNode
}) {
  const t = useT()
  return (
    <div className="mt-6 flex items-center gap-2.5 border-t border-line-soft pt-[18px]">
      <span className="mr-auto min-w-0 text-label leading-[1.4] text-ink-faint">{note}</span>
      <Button variant="ghost" className="flex-none gap-2" disabled={backDisabled} onClick={onBack}>
        <ArrowLeftIcon className="size-3.5" />
        {t('common.back')}
      </Button>
      {children}
    </div>
  )
}
