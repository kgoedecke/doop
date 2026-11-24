import { useRef, useState } from 'react'
import { useT } from '../lib/i18n'
import { AuthPage } from '../pages/AuthPage'
import { Button } from './ui/button'
import { Pressable } from './ui/pressable'
import { XIcon } from './ui/icons'
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from './ui/sheet'

export function MobileGuestSheet({
  launcherVisible,
  expanded,
  onExpandedChange,
}: {
  launcherVisible: boolean
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}) {
  const t = useT()
  const [mode, setMode] = useState<'signin' | 'signup'>('signup')
  const pointerY = useRef(0)
  const dragged = useRef(false)
  const closeButton = useRef<HTMLButtonElement | null>(null)
  const opener = useRef<HTMLButtonElement | null>(null)

  return (
    <section
      hidden={!launcherVisible}
      aria-label={t('canvas.accountOptions')}
      className="relative shrink-0 animate-in rounded-t-panel bg-surface pb-[env(safe-area-inset-bottom)] shadow-pop slide-in-from-bottom-full duration-200 motion-reduce:animate-none"
    >
      <Pressable
        className="grid h-11 touch-none place-items-center rounded-t-panel"
        aria-label={t('canvas.accountOptions')}
        aria-expanded={expanded}
        aria-controls="guest-account-actions"
        onPointerDown={(event) => {
          pointerY.current = event.clientY
          dragged.current = false
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerUp={(event) => {
          const distance = event.clientY - pointerY.current
          dragged.current = Math.abs(distance) > 12
          if (dragged.current) onExpandedChange(distance < 0)
        }}
        onClick={(event) => {
          if (!dragged.current || event.detail === 0) onExpandedChange(!expanded)
          dragged.current = false
        }}
      >
        <span aria-hidden className="h-1 w-12 rounded-full bg-ink-faint" />
      </Pressable>
      <Sheet>
        <div
          id="guest-account-actions"
          aria-hidden={!expanded}
          className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="mx-auto grid max-w-sm gap-2 px-5 pb-4">
              {(['signup', 'signin'] as const).map((action) => (
                <SheetTrigger asChild key={action}>
                  <Button
                    variant={action === 'signup' ? 'primary' : 'default'}
                    disabled={!expanded}
                    size="lg"
                    className="h-11"
                    onClick={(event) => {
                      opener.current = event.currentTarget
                      setMode(action)
                    }}
                  >
                    {t(action === 'signup' ? 'auth.signUp' : 'auth.signIn')}
                  </Button>
                </SheetTrigger>
              ))}
            </div>
          </div>
        </div>
        <SheetContent
          side="bottom"
          aria-describedby={undefined}
          onKeyDown={(event) => event.stopPropagation()}
          showCloseButton={false}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            closeButton.current?.focus()
          }}
          className="max-h-[90dvh] overflow-y-auto overscroll-contain rounded-t-panel bg-surface px-5 pt-6 pb-[calc(16px+env(safe-area-inset-bottom))] motion-reduce:animate-none"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (launcherVisible) opener.current?.focus()
            else document.querySelector<HTMLButtonElement>(`[data-guest-auth="${mode}"]`)?.focus()
          }}
        >
          <SheetTitle className="sr-only">{t('canvas.accountOptions')}</SheetTitle>
          <AuthPage initialMode={mode} inSheet />
          <SheetClose asChild>
            <Button
              ref={closeButton}
              variant="bare"
              size="icon"
              className="absolute top-2 right-2 size-11"
              aria-label={t('common.close')}
            >
              <XIcon size="rail" />
            </Button>
          </SheetClose>
        </SheetContent>
      </Sheet>
    </section>
  )
}
