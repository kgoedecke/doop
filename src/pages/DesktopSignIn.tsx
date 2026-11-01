import { useEffect, useMemo, useState } from 'react'
import { authClient } from '../lib/auth'
import { desktopHandoffURL, parseDesktopSignInQuery } from '../lib/desktopAuth'
import { AuthCard, AuthCardText, AuthScreen } from '../components/ui/screen'
import { Callout } from '../components/ui/callout'
import { useT } from '../lib/i18n'

/* Step 1 of the desktop sign-in (src/lib/desktopAuth.ts), in the system
   browser: begin the provider round trip here so better-auth's state cookie
   and the provider's callback share a cookie jar. If this browser already
   holds a doop session there is nothing to prove — go straight to the
   handoff. Renders only a holding card: the browser leaves within moments. */
export function DesktopSignIn({ signedIn }: { signedIn: boolean }) {
  const t = useT()
  /* read once: the query is fixed for the life of this page */
  const request = useMemo(() => parseDesktopSignInQuery(location.search), [])
  /* the provider's own words when it gave any; otherwise ours, picked at render */
  const [startError, setStartError] = useState<{ message?: string } | null>(null)
  const error = request
    ? startError && (startError.message ?? t('auth.desktopStartFailed'))
    : t('auth.desktopLinkIncomplete')

  useEffect(() => {
    if (!request) return
    const callbackURL = desktopHandoffURL(request.challenge, request.callbackURL)
    if (signedIn) {
      location.replace(callbackURL)
      return
    }
    /* the handoff carries the in-app landing through to the deep link, so
       a new account's first-canvas landing survives the hop too */
    const redirects = {
      callbackURL,
      newUserCallbackURL: desktopHandoffURL(request.challenge, request.newUserCallbackURL),
      errorCallbackURL: '/auth',
    }
    const start =
      request.provider === 'oidc'
        ? authClient.signIn.oauth2({ providerId: 'oidc', ...redirects })
        : authClient.signIn.social({ provider: request.provider, ...redirects })
    start
      .then((res) => {
        if (res.error) setStartError({ message: res.error.message })
      })
      .catch(() => setStartError({}))
  }, [request, signedIn])

  return (
    <AuthScreen>
      <AuthCard title={error ? t('auth.somethingWentWrongTitle') : t('auth.desktopSigningIn')}>
        {error ? <Callout tone="error">{error}</Callout> : <AuthCardText>{t('auth.desktopToProvider')}</AuthCardText>}
      </AuthCard>
    </AuthScreen>
  )
}
