import { useEffect, useMemo, useState } from 'react'
import { authClient } from '../lib/auth'
import { desktopHandoffURL, parseDesktopSignInQuery } from '../lib/desktopAuth'
import { AuthScreen } from '../components/ui/screen'
import { Wordmark } from '../components/ui/wordmark'
import { Callout } from '../components/ui/callout'

/* Step 1 of the desktop sign-in (src/lib/desktopAuth.ts), in the system
   browser: begin the provider round trip here so better-auth's state cookie
   and the provider's callback share a cookie jar. If this browser already
   holds a doop session there is nothing to prove — go straight to the
   handoff. Renders only a holding card: the browser leaves within moments. */
export function DesktopSignIn({ signedIn }: { signedIn: boolean }) {
  /* read once: the query is fixed for the life of this page */
  const request = useMemo(() => parseDesktopSignInQuery(location.search), [])
  const [startError, setStartError] = useState<string | null>(null)
  const error = request ? startError : 'This sign-in link is incomplete — go back to the doop app and try again.'

  useEffect(() => {
    if (!request) return
    const callbackURL = desktopHandoffURL(request.challenge, request.to)
    if (signedIn) {
      location.replace(callbackURL)
      return
    }
    const failed = 'Could not start sign-in — go back to the doop app and try again.'
    const start =
      request.provider === 'oidc'
        ? authClient.signIn.oauth2({ providerId: 'oidc', callbackURL, errorCallbackURL: '/auth' })
        : authClient.signIn.social({ provider: request.provider, callbackURL, errorCallbackURL: '/auth' })
    start
      .then((res) => {
        if (res.error) setStartError(res.error.message ?? failed)
      })
      .catch(() => setStartError(failed))
  }, [request, signedIn])

  return (
    <AuthScreen>
      <div className="flex w-[min(400px,100%)] flex-col gap-3.5 rounded-[12px] border border-line bg-surface p-6 pt-[30px] shadow-pop sm:p-9 sm:pb-7">
        <Wordmark className="mb-1.5" />
        <h1 className="font-serif text-[34px] font-normal leading-[1.05] tracking-[-0.015em]">
          {error ? 'Something went wrong.' : 'Signing you in…'}
        </h1>
        {error ? (
          <Callout tone="error">{error}</Callout>
        ) : (
          <p className="text-sm text-ink-soft">Taking you to your identity provider for the doop app.</p>
        )}
      </div>
    </AuthScreen>
  )
}
