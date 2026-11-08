import { useState } from 'react'
import { useStore, roleOf } from '../lib/store'
import { useT } from '../lib/i18n'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { IconButton } from './ui/icon-button'
import { EyeIcon, XIcon } from './ui/icons'

const bannerClass =
  'pointer-events-auto absolute bottom-3.5 left-1/2 z-30 flex max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-3 rounded-panel bg-surface py-1.5 pr-1.5 pl-3.5 text-body text-ink shadow-pop max-md:bottom-[72px]'

/** The note at the foot of a canvas someone can only look at, as Figma
 *  shows it: a signed-out guest is asked to sign up, a signed-in viewer or
 *  commenter is told what their link allows and may put it away. */
export function AccessBanner({
  guest,
  onSignUp,
  onSignIn,
  className,
}: {
  guest: boolean
  onSignUp?: () => void
  onSignIn?: () => void
  className?: string
}) {
  const t = useT()
  const role = useStore(roleOf)
  const loaded = useStore((s) => !!s.canvas)
  const [dismissed, setDismissed] = useState(false)
  if (!loaded || role === 'edit' || dismissed) return null

  if (guest)
    return (
      <div role="status" className={cn(bannerClass, className)}>
        <span className="min-w-0">{t('canvas.guestBanner')}</span>
        <span className="flex flex-none items-center gap-1.5">
          <Button size="sm" onClick={onSignIn}>
            {t('auth.signIn')}
          </Button>
          <Button size="sm" variant="primary" onClick={onSignUp}>
            {t('auth.signUp')}
          </Button>
        </span>
      </div>
    )

  return (
    <div role="status" className={cn(bannerClass, className)}>
      <EyeIcon size="rail" className="flex-none text-ink-soft" />
      <span className="min-w-0">
        {role === 'comment' ? t('canvas.readOnlyCommentBanner') : t('canvas.readOnlyViewBanner')}
      </span>
      <IconButton size="sm" aria-label={t('canvas.dismissBanner')} onClick={() => setDismissed(true)}>
        <XIcon size="rail" />
      </IconButton>
    </div>
  )
}
