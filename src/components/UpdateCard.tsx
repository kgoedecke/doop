import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DownloadIcon } from '@/components/ui/icons'
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
    <div aria-live="polite" className="fixed bottom-4 left-4 z-[80]">
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
  return (
    <Card
      role="region"
      aria-labelledby="update-card-title"
      aria-describedby="update-card-body"
      className={cn('w-[300px] rounded-panel p-4 shadow-pop animate-[chip-in_0.2s_ease]', className)}
    >
      <div className="flex size-11 items-center justify-center rounded-card bg-paper-deep text-ink-soft">
        <DownloadIcon size={20} aria-hidden />
      </div>
      <h2 id="update-card-title" className="mt-3 text-copy font-medium text-ink">
        {t('shell.updateTitle')}
      </h2>
      <p id="update-card-body" className="mt-1 text-pretty text-body text-ink-soft">
        {t('shell.updateBody', { version })}
      </p>
      <p className="mt-1 text-pretty text-caption text-ink-faint">{t('shell.updateAgentNote')}</p>
      <div className="mt-4 flex gap-2">
        <Button variant="primary" className="flex-1" disabled={restarting} onClick={onRestart}>
          {restarting ? t('shell.updateRestarting') : t('shell.updateRestart')}
        </Button>
        <Button className="flex-1" disabled={restarting} onClick={onLater}>
          {t('shell.updateLater')}
        </Button>
      </div>
    </Card>
  )
}
