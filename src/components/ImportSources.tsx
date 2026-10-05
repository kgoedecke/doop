import type { ReactNode, SVGProps } from 'react'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { ModalLede, ModalTitle } from './ui/modal'

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
  return (
    <>
      <ModalTitle>Import into Doop</ModalTitle>
      <ModalLede>
        Pick a source. Imports that find several pages or frames show a review before anything lands.
      </ModalLede>
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
            <span className="flex size-10 items-center justify-center overflow-hidden rounded-[10px] border border-line bg-surface">
              {source.icon}
            </span>
            <b className="mt-4 text-[15px] font-semibold tracking-[-0.012em]">{source.title}</b>
            <span className="mt-1 text-[12.5px] leading-[1.45] text-ink-soft">{source.blurb}</span>
            {source.soon ? (
              <span className="absolute right-4 top-4 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-faint">
                Soon
              </span>
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
  return (
    <div className="mt-6 flex items-center gap-2.5 border-t border-line-soft pt-[18px]">
      <span className="mr-auto min-w-0 text-[12px] leading-[1.4] text-ink-faint">{note}</span>
      <Button variant="ghost" className="flex-none gap-2" disabled={backDisabled} onClick={onBack}>
        <ArrowLeftIcon className="size-3.5" />
        Back
      </Button>
      {children}
    </div>
  )
}

/* ---- source marks the app doesn't already carry ---- */

function ArrowRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden {...props}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  )
}

function ArrowLeftIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden {...props}>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </svg>
  )
}

export function GlobeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14.5 14.5 0 0 1 0 18M12 3a14.5 14.5 0 0 0 0 18" />
    </svg>
  )
}

export function RadioTowerIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden {...props}>
      <path d="M4.9 16.1a7 7 0 0 1 0-9.9M7.8 13.2a3 3 0 0 1 0-5.7M19.1 16.1a7 7 0 0 0 0-9.9M16.2 13.2a3 3 0 0 0 0-5.7" />
      <circle cx="12" cy="10.5" r="1.5" fill="currentColor" stroke="none" />
      <path d="M12 12v9M9 21l3-6.5L15 21" />
    </svg>
  )
}
