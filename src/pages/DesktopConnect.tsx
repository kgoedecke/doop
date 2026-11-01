import { useEffect, useMemo } from 'react'
import { desktopConnectLink, parseDesktopConnectQuery } from '../lib/desktopConnect'
import { AuthCard, AuthCardText, AuthScreen } from '../components/ui/screen'
import { Button } from '../components/ui/button'
import { Callout } from '../components/ui/callout'
import { useT } from '../lib/i18n'

/* Step 2 of connecting an integration from the desktop app
   (shared/desktopConnect.ts): the provider sent the system browser back,
   and the server relayed its answer here untouched. Hand it to the app
   over the doop:// scheme; the app finishes the connection under its own
   account, whoever is signed in to this browser. */
export function DesktopConnect() {
  const t = useT()
  const link = useMemo(() => {
    const request = parseDesktopConnectQuery(location.search)
    return request && desktopConnectLink(request.provider, request.query)
  }, [])

  useEffect(() => {
    if (link) location.assign(link)
  }, [link])

  return (
    <AuthScreen>
      <AuthCard title={link ? t('auth.desktopConnectTitle') : t('auth.somethingWentWrongTitle')}>
        {link ? (
          <>
            <AuthCardText>{t('auth.desktopConnectBody')}</AuthCardText>
            <Button asChild className="mt-1">
              <a href={link}>{t('auth.openDoop')}</a>
            </Button>
          </>
        ) : (
          <Callout tone="error">{t('auth.desktopConnectFailed')}</Callout>
        )}
      </AuthCard>
    </AuthScreen>
  )
}
