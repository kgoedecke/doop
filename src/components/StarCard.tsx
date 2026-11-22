import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { StarIcon, XIcon } from '@/components/ui/icons'
import { GITHUB_REPO_URL, finishStarPrompt, noteActiveDay, snoozeStarPrompt, starPromptDue } from '@/lib/githubStar'
import { desktopCardDismissed, nativeAppPlatform } from '@/lib/nativeApp'
import { posthog } from '@/lib/posthog'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/* long enough that the page has painted and the person has seen where they
   are before anything slides in */
const PROMPT_DELAY_MS = 2500

type Outcome = 'starred' | 'later' | 'dismissed'

/** One ask at a time: while the rail's desktop-app card (NativeAppPromo.tsx)
 *  is up, the star waits for a later visit. */
function desktopCardShowing(): boolean {
  const platform = nativeAppPlatform()
  return !!platform && platform !== 'ios' && !desktopCardDismissed()
}

/** The "Enjoying Doop?" card asking for a GitHub star, bottom right on Home,
 *  once someone has used Doop on a few days (src/lib/githubStar.ts). `held`
 *  keeps it back while another modal (the onboarding questions) is up. */
export function StarCard({ held = false }: { held?: boolean }) {
  const [due, setDue] = useState(false)
  const [closed, setClosed] = useState(false)
  useEffect(() => {
    noteActiveDay()
    if (!starPromptDue() || desktopCardShowing()) return
    const timer = window.setTimeout(() => setDue(true), PROMPT_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [])
  const open = due && !held && !closed
  useEffect(() => {
    if (open) posthog.capture('github_star_prompt_shown')
  }, [open])
  const close = (outcome: Outcome) => {
    if (outcome === 'later') snoozeStarPrompt()
    else finishStarPrompt(outcome)
    posthog.capture('github_star_prompt_closed', { outcome })
    setClosed(true)
  }
  /* the live region stays mounted so the card is announced when it appears,
     without taking focus; hidden on phones, where it would cover the page */
  return (
    <div aria-live="polite" className="fixed right-4 bottom-4 z-[70] hidden md:block">
      {open && (
        <StarCardView
          onStar={() => close('starred')}
          onLater={() => close('later')}
          onDismiss={() => close('dismissed')}
        />
      )}
    </div>
  )
}

type StarCardViewProps = {
  onStar?: () => void
  onLater: () => void
  onDismiss: () => void
  className?: string
}

export function StarCardView({ onStar, onLater, onDismiss, className }: StarCardViewProps) {
  const t = useT()
  /* the update card's shape (UpdateCard.tsx): a titled panel, its dismiss in the header */
  return (
    <section
      aria-labelledby="star-card-title"
      aria-describedby="star-card-body"
      className={cn(
        'flex w-[300px] flex-col gap-3 rounded-panel bg-surface px-5 pt-4 pb-5 shadow-pop animate-[chip-in_0.2s_ease]',
        className,
      )}
    >
      <header className="flex items-center justify-between">
        <h2 id="star-card-title" className="flex items-center gap-2 text-lead font-semibold text-ink">
          <StarIcon size="button" className="fill-warning text-warning-ink" aria-hidden />
          {t('shell.starTitle')}
        </h2>
        <IconButton size="sm" className="-mr-1" aria-label={t('shell.starDismiss')} onClick={onDismiss}>
          <XIcon size="rail" />
        </IconButton>
      </header>
      <p id="star-card-body" className="text-pretty text-body text-ink-soft">
        {t('shell.starBody')}
      </p>
      <div className="flex gap-2">
        <Button asChild variant="primary" size="md" className="flex-1 justify-center">
          <a href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer" onClick={onStar}>
            <StarIcon size="rail" aria-hidden />
            {t('shell.starAction')}
          </a>
        </Button>
        <Button variant="default" size="md" onClick={onLater}>
          {t('shell.starLater')}
        </Button>
      </div>
    </section>
  )
}
