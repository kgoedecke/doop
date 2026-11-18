import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { AppIcon, BrandMark, type AppIconBrand } from '@/components/ui/brand-mark'
import { DownloadIcon, MinusIcon } from '@/components/ui/icons'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import {
  type NativeAppPlatform,
  desktopCardDismissed,
  dismissNativeApp,
  iosPromptSnoozed,
  nativeAppPlatform,
  nativeAppUrl,
} from '@/lib/nativeApp'
import { posthog } from '@/lib/posthog'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { DoopMark } from './Logo'

/* The suggestion to use a native app instead of the browser: a card at the
   foot of the rail on a computer (the desktop app), and a sheet from the
   bottom on an iPhone or iPad (the App Store). Neither shows inside the
   desktop app, nor where no app exists (Android, ChromeOS). */

type DesktopPlatform = Exclude<NativeAppPlatform, 'ios'>

function track(event: 'native_app_promo_clicked' | 'native_app_promo_dismissed', platform: NativeAppPlatform) {
  posthog.capture(event, { platform, surface: platform === 'ios' ? 'sheet' : 'rail_card' })
}

/** The agents that design in Doop, either side of its tile. */
const AGENTS_LEFT: AppIconBrand[] = ['cursor', 'claude-code']
const AGENTS_RIGHT: AppIconBrand[] = ['claude', 'codex']

/** The wave's bar heights: the home hero's swell, shortened to fit a card,
 *  its crest under the Doop tile. */
const WAVE = [30, 38, 34, 48, 44, 60, 72, 88, 100, 92, 78, 64, 52, 40, 46, 34]

/** Doop's app tile, drawn so it stays crisp at any size. */
function DoopTile({ size }: { size: number }) {
  return (
    <span
      className="grid flex-none place-items-center shadow-pop"
      /* the app icon's own ink, the same in both themes */
      style={{ width: size, height: size, borderRadius: '23%', background: '#1d1c1a' }}
    >
      <span style={{ width: size * 0.46, height: size * 0.6 }}>
        <DoopMark size="fill" color="#e9e7e2" className="block" />
      </span>
    </span>
  )
}

/** The home hero's gradient wave, held still, behind Doop and the agents
 *  that work in it. The row bleeds off both sides, faded where it leaves. */
function AppHero({ size }: { size: 'card' | 'sheet' }) {
  const tile = size === 'card' ? 60 : 76
  const agent = size === 'card' ? 38 : 46
  return (
    <div aria-hidden className={cn('relative overflow-hidden bg-surface', size === 'card' ? 'h-[118px]' : 'h-[160px]')}>
      <div className="absolute inset-0 dark:opacity-60">
        <div
          className="hero-wave absolute inset-x-0 bottom-0 flex h-[85%] items-end opacity-90 blur-[14px] saturate-[1.15] [mask-image:linear-gradient(to_bottom,transparent,#000_40%,#000_70%,transparent)]"
          style={{ animation: 'none' }}
        >
          {WAVE.map((h, i) => (
            <i key={i} style={{ height: `${h}%`, animation: 'none' }} />
          ))}
        </div>
      </div>
      <div className="absolute inset-0 flex items-center justify-center gap-3 [mask-image:linear-gradient(90deg,transparent,#000_16%,#000_84%,transparent)]">
        {AGENTS_LEFT.map((brand) => (
          <AppIcon key={brand} brand={brand} size={agent} />
        ))}
        <DoopTile size={tile} />
        {AGENTS_RIGHT.map((brand) => (
          <AppIcon key={brand} brand={brand} size={agent} />
        ))}
      </div>
    </div>
  )
}

const PLATFORM_NAMES: Record<DesktopPlatform, string> = { macos: 'macOS', windows: 'Windows', linux: 'Linux' }

/** The rail's desktop-app card, for a computer's browser. */
export function NativeAppCard({ className }: { className?: string }) {
  const [platform] = useState(() => {
    const found = nativeAppPlatform()
    return found && found !== 'ios' && !desktopCardDismissed() ? found : null
  })
  const [open, setOpen] = useState(true)
  if (!platform || !open) return null
  return (
    <NativeAppCardView
      platform={platform}
      className={className}
      onDownload={() => track('native_app_promo_clicked', platform)}
      onDismiss={() => {
        dismissNativeApp('card')
        track('native_app_promo_dismissed', platform)
        setOpen(false)
      }}
    />
  )
}

type NativeAppCardViewProps = {
  platform: DesktopPlatform
  onDownload?: () => void
  onDismiss: () => void
  className?: string
}

export function NativeAppCardView({ platform, onDownload, onDismiss, className }: NativeAppCardViewProps) {
  const t = useT()
  return (
    <section
      aria-labelledby="native-app-card-title"
      className={cn(
        'relative flex flex-col overflow-hidden rounded-card bg-surface shadow-ring animate-[chip-in_0.2s_ease]',
        className,
      )}
    >
      <AppHero size="card" />
      <IconButton
        size="sm"
        className="absolute top-1.5 right-1.5 bg-surface/70 backdrop-blur-sm"
        aria-label={t('shell.appPromoDismiss')}
        onClick={onDismiss}
      >
        <MinusIcon size="rail" />
      </IconButton>
      <div className="flex flex-col gap-1 px-3.5 pt-3 pb-3.5">
        <h2 id="native-app-card-title" className="text-body font-semibold text-ink">
          {t('shell.appPromoDesktopTitle')}
        </h2>
        <p className="text-pretty text-caption text-ink-soft">{t('shell.appPromoDesktopBody')}</p>
        <Button asChild variant="primary" size="sm" block className="mt-2 justify-center">
          <a href={nativeAppUrl(platform)} target="_blank" rel="noopener noreferrer" onClick={onDownload}>
            <DownloadIcon size="rail" aria-hidden />
            {t('shell.appPromoDownloadFor', { platform: PLATFORM_NAMES[platform] })}
          </a>
        </Button>
      </div>
    </section>
  )
}

/* long enough that the page has painted and the person has seen where they
   are before anything slides over it */
const PROMPT_DELAY_MS = 1500

/** The App Store sheet on an iPhone or iPad, once per fortnight at most.
 *  `held` keeps it back while another modal (the onboarding questions) is up
 *  or may still open. */
export function IosAppPrompt({ held = false }: { held?: boolean }) {
  const [due, setDue] = useState(false)
  const [closed, setClosed] = useState(false)
  useEffect(() => {
    if (nativeAppPlatform() !== 'ios' || iosPromptSnoozed()) return
    const timer = window.setTimeout(() => setDue(true), PROMPT_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [])
  /* any way out (the button, Escape, a tap outside) counts as "not now",
     and so does going to the App Store: the browser tab stays behind */
  const close = (event: 'native_app_promo_clicked' | 'native_app_promo_dismissed') => {
    dismissNativeApp('ios')
    track(event, 'ios')
    setClosed(true)
  }
  return (
    <IosAppSheet
      open={due && !held && !closed}
      onOpenChange={(next) => !next && close('native_app_promo_dismissed')}
      onGet={() => close('native_app_promo_clicked')}
    />
  )
}

type IosAppSheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onGet?: () => void
}

export function IosAppSheet({ open, onOpenChange, onGet }: IosAppSheetProps) {
  const t = useT()
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="gap-0 overflow-hidden rounded-t-panel border-t-0 bg-surface p-0 pb-[env(safe-area-inset-bottom)]"
      >
        <AppHero size="sheet" />
        <div className="flex flex-col items-center gap-1.5 px-6 pt-5 pb-6 text-center">
          <SheetTitle className="text-heading font-semibold text-ink">{t('shell.appPromoIosTitle')}</SheetTitle>
          <SheetDescription className="max-w-[34ch] text-pretty text-copy text-ink-soft">
            {t('shell.appPromoIosBody')}
          </SheetDescription>
          <div className="mt-4 flex w-full max-w-sm flex-col gap-2">
            <Button asChild variant="primary" size="lg" block>
              <a href={nativeAppUrl('ios')} target="_blank" rel="noopener noreferrer" onClick={onGet}>
                <BrandMark brand="apple" size={18} className="shrink-0" />
                {t('shell.appPromoIosGet')}
              </a>
            </Button>
            <Button variant="bare" size="lg" block onClick={() => onOpenChange(false)}>
              {t('shell.appPromoIosLater')}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
