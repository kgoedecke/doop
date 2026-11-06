import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { DownloadIcon, XIcon } from '@/components/ui/icons'
import { type UpdateOffer, listenForUpdates, restartToUpdate } from '@/lib/desktopUpdate'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/** The desktop shell's "Update available" card (src/lib/desktopUpdate.ts):
 *  mounted once over every screen, empty until the shell offers an update. */
export function UpdateCard() {
  const [offer, setOffer] = useState<UpdateOffer | null>(null)
  useEffect(() => listenForUpdates(setOffer), [])
  /* the live region stays mounted so the card is announced when it appears,
     without taking focus from whatever the person is doing */
  return (
    /* bottom right, just above the canvas's zoom pill (14px in, 36px tall),
       so it never covers the zoom or the getting-started card on the left */
    <div aria-live="polite" className="fixed right-3.5 bottom-[58px] z-[80]">
      {offer && <UpdateCardControls offer={offer} onLater={() => setOffer(null)} />}
    </div>
  )
}

function UpdateCardControls({ offer, onLater }: { offer: UpdateOffer; onLater: () => void }) {
  const [restarting, setRestarting] = useState(false)
  return (
    <UpdateCardView
      version={offer.version}
      restarting={restarting}
      onRestart={() => {
        setRestarting(true)
        restartToUpdate()
          .catch(console.error)
          .finally(() => setRestarting(false))
      }}
      /* the download stays with the shell: offered again by the next check
         and, on macOS, installed on quit */
      onLater={onLater}
    />
  )
}

type UpdateCardViewProps = {
  version: string
  restarting?: boolean
  onRestart: () => void
  onLater: () => void
  className?: string
}

export function UpdateCardView({ version, restarting = false, onRestart, onLater, className }: UpdateCardViewProps) {
  const t = useT()
  /* the canvas's getting-started card in shape (src/components/Onboarding.tsx):
     a titled panel with its dismiss in the header */
  return (
    <section
      aria-labelledby="update-card-title"
      aria-describedby="update-card-body"
      className={cn(
        'flex w-[340px] flex-col gap-3 rounded-panel bg-surface px-5 pt-4 pb-5 shadow-pop animate-[chip-in_0.2s_ease]',
        className,
      )}
    >
      <header className="flex items-center justify-between">
        <h2 id="update-card-title" className="flex items-center gap-2 text-lead font-semibold text-ink">
          <DownloadIcon size="rail" className="text-brand" aria-hidden />
          {t('shell.updateTitle')}
        </h2>
        <IconButton
          size="sm"
          className="-mr-1"
          aria-label={t('shell.updateLater')}
          disabled={restarting}
          onClick={onLater}
        >
          <XIcon size="rail" />
        </IconButton>
      </header>
      <div className="flex flex-col gap-1">
        <p id="update-card-body" className="text-pretty text-body text-ink-soft">
          {t('shell.updateBody', { version })}
        </p>
        <p className="text-pretty text-caption text-ink-faint">{t('shell.updateAgentNote')}</p>
      </div>
      <Button variant="primary" size="sm" className="self-start" disabled={restarting} onClick={onRestart}>
        {restarting ? t('shell.updateRestarting') : t('shell.updateRestart')}
      </Button>
    </section>
  )
}
