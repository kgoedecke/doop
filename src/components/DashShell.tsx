import * as React from 'react'
import { authClient } from '../lib/auth'
import { navigate } from '../App'
import { posthog } from '../lib/posthog'
import { useMe } from '../lib/me'
import { isDesktopShell } from '../lib/shell'
import { desktopDownloadUrl } from '../lib/desktopDownload'
import { isTheme, useTheme } from '../lib/theme'
import { LOCALES, LOCALE_NAMES, isLocale, useLocale, useT } from '../lib/i18n'
import { colorFor } from '../../shared/types'
import { themeOptions } from './ThemePicker'
import { Badge } from './ui/badge'
import { Avatar } from './ui/avatar'
import { IconButton } from './ui/icon-button'
import { Pressable } from './ui/pressable'
import { PersonRow } from './ui/list'
import {
  DropdownMenu,
  DropdownMenuCaption,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { DownloadIcon, GearIcon, HelpIcon, LogOutIcon, ShieldIcon } from './ui/icons'

/** The account menu the signed-in shell repeats on every page: in the rail
 *  and in the settings header. It lives here so they cannot drift apart. */

export function AccountMenu({
  face = false,
  side,
  align,
}: {
  /** the round presence face the editor's rail wears, instead of the ink square */
  face?: boolean
  side?: React.ComponentProps<typeof DropdownMenuContent>['side']
  align?: React.ComponentProps<typeof DropdownMenuContent>['align']
} = {}) {
  const { data: session } = authClient.useSession()
  const me = useMe(session?.user.id)
  const { theme, setTheme } = useTheme()
  const { locale, setLocale } = useLocale()
  const t = useT()
  const name = session?.user.name ?? ''
  const downloadUrl = desktopDownloadUrl()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {face ? (
          <IconButton
            aria-label={t('shell.account')}
            title={name}
            shape="round"
            className="size-7 hover:bg-transparent focus-visible:ring-ink-faint data-[state=open]:ring-2 data-[state=open]:ring-ink-faint"
          >
            <Avatar name={name} color={colorFor(session?.user.id ?? name)} size={28} className="shadow-none" />
          </IconButton>
        ) : (
          <Pressable
            aria-label={t('shell.account')}
            title={name}
            layout="inline"
            focus="ring"
            className="flex-none rounded-full"
          >
            <Avatar tone="ink" name={name} size={34} />
          </Pressable>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align} width="lg">
        <DropdownMenuLabel className="px-2.5 pb-2.5 pt-2">
          <PersonRow
            avatar={<Avatar name={name} color={colorFor(session?.user.id ?? name)} size={32} className="shadow-none" />}
            name={name}
            detail={me?.email ?? session?.user.email}
          />
        </DropdownMenuLabel>
        {/* the plan is a workspace thing; this line says which side of it the
            account is on — a member of a live paid workspace is on Team */}
        <div className="mx-2.5 mb-2 flex items-center gap-[7px] text-caption text-ink-soft">
          {me?.plan === 'team' ? (
            <>
              <Badge tone="accent">team</Badge> {t('shell.teamPlan')}
            </>
          ) : (
            <>
              <Badge>free</Badge> {t('shell.personalPlan')}
            </>
          )}
        </div>
        <DropdownMenuSeparator />
        {downloadUrl && (
          <DropdownMenuItem asChild>
            <a href={downloadUrl} target="_blank" rel="noopener noreferrer">
              <DownloadIcon size="rail" /> {t('shell.getDesktopApp')}
            </a>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => navigate('/settings')}>
          <GearIcon size="rail" /> {t('shell.settings')}
        </DropdownMenuItem>
        {me?.admin && (
          <DropdownMenuItem onSelect={() => navigate('/admin')}>
            <ShieldIcon size="rail" /> {t('shell.admin')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <a href="/docs" target="_blank" rel="noopener noreferrer">
            <HelpIcon size="rail" /> {t('shell.helpDocs')}
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* the theme is one click from every page; picking one keeps the menu
            open so the change can be seen, and judged, before it closes */}
        <DropdownMenuCaption>{t('shell.appearance')}</DropdownMenuCaption>
        <DropdownMenuRadioGroup value={theme} onValueChange={(next) => isTheme(next) && setTheme(next)}>
          {themeOptions.map(({ value, label, Icon }) => (
            <DropdownMenuRadioItem key={value} value={value} onSelect={(e) => e.preventDefault()}>
              <Icon size="rail" /> {t(label)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {/* the language sits beside the theme for the same reason, each named
            in itself so someone who cannot read the current one finds theirs */}
        <DropdownMenuCaption>{t('shell.language')}</DropdownMenuCaption>
        <DropdownMenuRadioGroup value={locale} onValueChange={(next) => isLocale(next) && setLocale(next)}>
          {LOCALES.map((value) => (
            <DropdownMenuRadioItem key={value} value={value} lang={value} onSelect={(e) => e.preventDefault()}>
              {LOCALE_NAMES[value]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          tone="danger"
          onSelect={() =>
            authClient.signOut().then(() => {
              posthog.reset()
              /* the shell has no marketing site: a signed-out reload of /
                 would show the landing page, so it goes to the sign-in form
                 the shell opens on (main.rs) */
              if (isDesktopShell()) location.assign('/auth')
              else location.reload()
            })
          }
        >
          <LogOutIcon size="rail" /> {t('shell.logOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
