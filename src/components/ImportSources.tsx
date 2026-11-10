import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { ChoiceList, ChoiceRow } from './ui/choice-list'
import { ArrowLeftIcon } from './ui/icons'
import { ModalLede, ModalTitle } from './ui/modal'
import { useT } from '@/lib/i18n'

/**
 * The import modal's two-step chrome: a list of sources, then one screen
 * per source. Each screen shares the same bones — the source's app icon
 * beside the title, a lede, the source's own body, and a footer of fine
 * print with Back and the primary action.
 */

export interface ImportSource {
  id: string
  title: string
  blurb: string
  /** the source's `AppIcon` at the list's 32px */
  icon: ReactNode
  /** greyed out with a "Soon" tag; the row does not navigate */
  soon?: boolean
}

export function SourcePicker({ sources, onPick }: { sources: ImportSource[]; onPick: (id: string) => void }) {
  const t = useT()
  return (
    <>
      <ModalTitle>{t('panels.importTitle')}</ModalTitle>
      <ModalLede>{t('panels.importLede')}</ModalLede>
      <ChoiceList className="mt-5">
        {sources.map((source) => (
          <ChoiceRow
            key={source.id}
            icon={source.icon}
            title={source.title}
            description={source.blurb}
            disabled={source.soon}
            trailing={source.soon ? <span className="text-caption">{t('panels.importSoon')}</span> : undefined}
            onClick={() => !source.soon && onPick(source.id)}
          />
        ))}
      </ChoiceList>
    </>
  )
}

/** The source's `AppIcon` (40px) beside the screen's title and its lede,
 *  as Connect AI heads an agent's steps. */
export function ImportStepHeader({ icon, title, lede }: { icon: ReactNode; title: ReactNode; lede?: ReactNode }) {
  return (
    <div className={cn('flex gap-3.5', lede ? 'items-start' : 'items-center')}>
      <span className="flex-none">{icon}</span>
      <div className="min-w-0">
        <ModalTitle>{title}</ModalTitle>
        {lede && <ModalLede>{lede}</ModalLede>}
      </div>
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
