import { useEffect, useState } from 'react'
import { authClient } from '../lib/auth'
import { BrandMark } from '../components/ui/brand-mark'
import { setName } from '../lib/identity'
import { beginBrowserSignIn, supportsBrowserSignIn } from '../lib/desktop'
import type { DesktopSignInProvider, ProviderRedirects } from '../lib/desktopAuth'
import { safeRelativeTarget } from '../lib/safeTarget'
import { CODEX_SETUP_PATH } from '../lib/codexConnection'
import { FIRST_CANVAS_PATH, firstCanvasPathAfterSignup } from '../../shared/firstCanvas'
import { isDesktopShell } from '../lib/shell'
import { posthog } from '../lib/posthog'
import { AuthCard, AuthCardText, AuthScreen } from '../components/ui/screen'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Field } from '../components/ui/field'
import { Callout } from '../components/ui/callout'

/* If login interrupted an MCP OAuth authorize redirect, send the browser
   back into the flow so the agent connection completes. */
/* better-auth deliberately returns the same "invalid email or password" for
   unknown emails and wrong passwords; this tells the two apart so the login
   page can route would-be signups to the right form. */
async function accountExists(email: string): Promise<boolean> {
  try {
    const res = await fetch('/api/account-exists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    if (!res.ok) return true // unknown — fall back to the generic error
    return (await res.json()).exists
  } catch {
    return true
  }
}

function interruptedTarget(): string | null {
  if (location.pathname === '/oauth/consent' || location.pathname === CODEX_SETUP_PATH)
    return location.pathname + location.search
  const params = new URLSearchParams(location.search)
  const target = safeRelativeTarget(params.get('redirect_to') || params.get('redirect_uri'))
  if (target) return target
  if (params.has('client_id') && params.has('response_type')) return `/api/auth/mcp/authorize${location.search}`
  return null
}

/* Where the verification link lands a signup that had to confirm its email
   first (SMTP on): the interrupted flow if there was one, else the first
   canvas — the same landing an instantly signed-in signup gets below. */
function verifiedLanding(): string {
  return interruptedTarget() ?? FIRST_CANVAS_PATH
}

function resumeOAuthFlow(): boolean {
  const target = interruptedTarget()
  if (target) location.href = target
  return target !== null
}

type AuthMode = 'signin' | 'signup' | 'forgot' | 'reset'

/** the card's title for each mode */
const TITLES: Record<AuthMode, string> = {
  signin: 'Welcome back.',
  signup: 'Create your account.',
  forgot: 'Reset your password.',
  reset: 'Pick a new password.',
}

/** The redirect knobs shared by better-auth's social and oauth2 sign-ins. */
interface ProviderStart extends ProviderRedirects {
  errorCallbackURL: string
}

/* The providers' marks at the 18px their sign-in guidelines draw them, from the registry. */
function MicrosoftMark() {
  return <BrandMark brand="microsoft" size={18} className="shrink-0" />
}

function AppleMark() {
  return <BrandMark brand="apple" size={18} className="shrink-0" />
}

function GoogleMark() {
  return <BrandMark brand="google" size={18} className="shrink-0" />
}

/* Human copy for the OAuth error codes better-auth's callback can redirect
   back with (see redirectOnError in its oauth2 package) — everything else
   falls back to a generic message. account_not_linked is the one an
   operator is most likely to actually hit: an existing local account whose
   email the IdP claims, but that better-auth's own gate refused to link
   (see linkVerifiedProviderEmail in server/auth.ts for why that should now be
   rare, not why it can still happen — a provider that never sends
   email_verified, for instance). */
const SSO_ERROR_MESSAGES: Record<string, string> = {
  account_not_linked:
    'That email already has a doop account that could not be linked automatically — sign in with email/password instead.',
  "email_doesn't_match": "The signed-in email doesn't match the account you started from — try again.",
  email_is_missing: "Your identity provider didn't share an email address — doop needs one to sign you in.",
  email_not_found: "Your identity provider didn't share an email address — doop needs one to sign you in.",
  /* the desktop shell's browser handoff (src/lib/desktopAuth.ts) came back with a spent or expired token */
  desktop_handoff: 'That sign-in link has expired — start again and finish in your browser within a couple of minutes.',
}

/* A failure inside the IdP round trip (the browser has already left and
   come back) redirects here with ?error=<code> rather than throwing where
   ssoSignIn's own res.error check could see it — that check only ever
   catches failures of the *initiating* request (e.g. unknown providerId). */
/* better-auth's OAuth callbacks relay an error thrown by our own user-create
   hook (SIGNUP_EMAIL_DOMAINS, see assertSignupDomainAllowed in
   server/auth.ts) as the ?error= code itself, message with its spaces
   turned into underscores. Neither the message's words nor an email domain
   contain underscores, so flipping them back restores it verbatim. */
const SIGNUP_RESTRICTED_PREFIX = 'Sign_up_is_restricted'

function ssoErrorFromUrl(): string | null {
  const params = new URLSearchParams(location.search)
  const code = params.get('error')
  if (!code) return null
  if (code.startsWith(SIGNUP_RESTRICTED_PREFIX)) return code.replaceAll('_', ' ')
  const description = params.get('error_description')
  if (description) return description
  return SSO_ERROR_MESSAGES[code] ?? 'Sign-in failed — try again or use email/password.'
}

/* Where a provider sign-in should land, mirroring what the email form does
   after submit — but handed to the server as redirect URLs rather than
   navigated to directly. The browser leaves for the IdP and returns already
   carrying a session, so this component's own resumeOAuthFlow() never gets
   to run for this path; the equivalent logic has to travel with the
   request instead. An interrupted flow wins for everyone; otherwise a
   returning user comes back to this page and a new account lands on its
   first canvas, the same place the email signup goes, tagged with the
   provider so the app can report the signup once it lands (App.tsx). */
function ssoRedirects(provider: DesktopSignInProvider): ProviderRedirects {
  const target = interruptedTarget()
  if (target) return { callbackURL: target, newUserCallbackURL: target }
  return { callbackURL: location.pathname + location.search, newUserCallbackURL: firstCanvasPathAfterSignup(provider) }
}

/** Matches server/auth.ts loginProvidersConfig's response shape. */
interface OidcClientConfig {
  enabled: boolean
  displayName?: string
  google: boolean
  microsoft: boolean
  /** the browser "Sign in with Apple" (the iOS app's native one is appleNative, not shown here) */
  apple: boolean
}

/* The client bundle is static and shared across self-hosted deploys — it
   can't know at build time whether the operator configured SSO, so it asks
   the server. See server/auth.ts loginProvidersConfig. */
function useOidcConfig(): OidcClientConfig {
  const [config, setConfig] = useState<OidcClientConfig>({
    enabled: false,
    google: false,
    microsoft: false,
    apple: false,
  })
  useEffect(() => {
    fetch('/api/oidc-config')
      .then((res) => (res.ok ? res.json() : { enabled: false, google: false, microsoft: false, apple: false }))
      .then(setConfig)
      .catch(() => {}) // SSO button just doesn't appear — email/password still works
  }, [])
  return config
}

/* Set once the desktop shell has sent a provider sign-in to the system
   browser. Lives outside the component because the sign-in request makes
   the auth client re-check the session, App swaps in its pending screen for
   a moment, and this form remounts with fresh state — the notice would be
   gone before anyone read it. A page load (the sign-in landing) resets it. */
let browserSignInNotice: string | null = null

export function AuthPage() {
  const oidc = useOidcConfig()
  /* better-auth lands password-reset links on /auth/reset?token=… */
  const resetToken = location.pathname === '/auth/reset' ? new URLSearchParams(location.search).get('token') : null
  const [mode, setMode] = useState<AuthMode>(resetToken ? 'reset' : 'signin')
  const [name, setNameField] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(ssoErrorFromUrl)
  /* informational state (not an error): "check your email" and friends */
  const [notice, setNotice] = useState<string | null>(browserSignInNotice)
  /* signin failed on an unverified email — offer a resend */
  const [unverified, setUnverified] = useState(false)
  /* set when the error's real fix is the other mode: signin with an unknown
     email, or signup with an existing one */
  const [suggestMode, setSuggestMode] = useState<'signin' | 'signup' | null>(null)
  const [busy, setBusy] = useState(false)

  function switchMode(next: AuthMode) {
    setMode(next)
    setError(null)
    setNotice(null)
    setSuggestMode(null)
    setUnverified(false)
  }

  /* the SSO error code has been shown; keep it out of the address bar */
  useEffect(() => {
    if (ssoErrorFromUrl()) history.replaceState(null, '', location.pathname)
  }, [])

  /* Both providers leave for the IdP and come back with a session (or an
     ?error= — see ssoErrorFromUrl); success redirects the browser away
     immediately, so only the failure to *start* leaves us here to show
     something. */
  async function providerSignIn(
    provider: DesktopSignInProvider,
    start: (opts: ProviderStart) => Promise<{ error?: { message?: string } | null }>,
  ) {
    setError(null)
    setNotice(null)
    setBusy(true)
    const startFailed = 'Could not start sign-in — try again or use email/password.'
    try {
      if (isDesktopShell() && supportsBrowserSignIn()) {
        /* Identity providers refuse embedded webviews, so the desktop shell
           signs in through the system browser and gets the session handed
           back over a doop:// link (src/lib/desktopAuth.ts). The browser
           starts the provider round trip itself, from a doop page. */
        if (!(await beginBrowserSignIn(provider, ssoRedirects(provider)))) {
          setError(startFailed)
          return
        }
        browserSignInNotice = 'Finish signing in in your browser — doop signs you in here the moment you come back.'
        setNotice(browserSignInNotice)
        return
      }
      const res = await start({ ...ssoRedirects(provider), errorCallbackURL: '/auth' })
      if (res.error) setError(res.error.message ?? startFailed)
    } finally {
      setBusy(false)
    }
  }

  function ssoSignIn() {
    return providerSignIn('oidc', (opts) => authClient.signIn.oauth2({ providerId: 'oidc', ...opts }))
  }

  function socialSignIn(provider: 'google' | 'microsoft' | 'apple') {
    return providerSignIn(provider, (opts) => authClient.signIn.social({ provider, ...opts }))
  }

  async function resendVerification() {
    setBusy(true)
    try {
      await authClient.sendVerificationEmail({ email, callbackURL: verifiedLanding() })
      setError(null)
      setUnverified(false)
      setNotice('Verification email sent — check your inbox.')
    } finally {
      setBusy(false)
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setNotice(null)
    setSuggestMode(null)
    setUnverified(false)
    setBusy(true)
    try {
      if (mode === 'forgot') {
        await authClient.requestPasswordReset({ email, redirectTo: '/auth/reset' })
        /* same response either way — this must not confirm account existence */
        setNotice('If an account exists for that email, a reset link is on its way.')
        return
      }
      if (mode === 'reset') {
        const res = await authClient.resetPassword({ newPassword: password, token: resetToken ?? '' })
        if (res.error) {
          setError(res.error.message ?? 'This reset link is invalid or expired — request a new one.')
        } else {
          history.replaceState(null, '', '/auth')
          switchMode('signin')
          setNotice('Password updated — sign in with your new password.')
        }
        return
      }
      const res =
        mode === 'signup'
          ? await authClient.signUp.email({
              name: name.trim() || email.split('@')[0] || email,
              email,
              password,
              callbackURL: verifiedLanding(),
            })
          : await authClient.signIn.email({ email, password })
      if (res.error) {
        if (mode === 'signin' && res.error.code === 'EMAIL_NOT_VERIFIED') {
          setError('This email hasn’t been verified yet.')
          setUnverified(true)
        } else if (mode === 'signin' && !(await accountExists(email))) {
          setError('No account found for this email.')
          setSuggestMode('signup')
          posthog.capture('login_no_account_found')
        } else if (mode === 'signup' && res.error.code?.startsWith('USER_ALREADY_EXISTS')) {
          setError('An account with this email already exists.')
          setSuggestMode('signin')
        } else {
          setError(res.error.message ?? 'Something went wrong')
        }
      } else if (res.data?.user) {
        /* signup with verification required: the account exists but there is
           no session yet — better-auth returns a null token in that case */
        if (mode === 'signup' && !res.data.token) {
          posthog.capture('account_signed_up', { method: 'email' })
          setNotice(`Almost there — we sent a verification link to ${email}. Open it to activate your account.`)
          return
        }
        if (mode === 'signup') posthog.capture('account_signed_up', { method: 'email' })
        else posthog.capture('account_signed_in')
        setName(res.data.user.name) // keep cursor/feed identity in sync with the account
        /* land new users on their auto-created first canvas, where the
           demo agent is waiting to perform */
        if (!resumeOAuthFlow() && mode === 'signup') location.href = FIRST_CANVAS_PATH
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthScreen>
      <AuthCard as="form" title={TITLES[mode]} onSubmit={submit}>
        <AuthCardText className="mb-2">
          {mode === 'forgot' ? (
            <>Enter your account email and we&rsquo;ll send you a reset link.</>
          ) : mode === 'reset' ? (
            <>Choose a new password for your account.</>
          ) : (
            <>
              A shared canvas for humans <em className="not-italic text-brand">&amp; agents</em>. Sign{' '}
              {mode === 'signin' ? 'in to your canvases' : 'up to start designing'}.
            </>
          )}
        </AuthCardText>
        {(oidc.enabled || oidc.google || oidc.microsoft || oidc.apple) && (mode === 'signin' || mode === 'signup') && (
          <>
            {oidc.google && (
              <Button
                variant="default"
                size="lg"
                block
                className="border-line"
                type="button"
                onClick={() => socialSignIn('google')}
                disabled={busy}
              >
                <GoogleMark />
                {mode === 'signup' ? 'Sign up' : 'Sign in'} with Google
              </Button>
            )}
            {oidc.microsoft && (
              <Button
                variant="default"
                size="lg"
                block
                className="border-line"
                type="button"
                onClick={() => socialSignIn('microsoft')}
                disabled={busy}
              >
                <MicrosoftMark />
                {mode === 'signup' ? 'Sign up' : 'Sign in'} with Microsoft
              </Button>
            )}
            {oidc.apple && (
              <Button
                variant="default"
                size="lg"
                block
                className="border-line"
                type="button"
                onClick={() => socialSignIn('apple')}
                disabled={busy}
              >
                <AppleMark />
                {mode === 'signup' ? 'Sign up' : 'Sign in'} with Apple
              </Button>
            )}
            {oidc.enabled && (
              <Button
                variant="default"
                size="lg"
                block
                className="border-line"
                type="button"
                onClick={ssoSignIn}
                disabled={busy}
              >
                {mode === 'signup' ? 'Sign up' : 'Sign in'} with {oidc.displayName}
              </Button>
            )}
            <div className="flex items-center gap-3 text-[11px] uppercase tracking-wide text-ink-faint">
              <span className="h-px flex-1 bg-line" />
              or
              <span className="h-px flex-1 bg-line" />
            </div>
          </>
        )}
        {mode === 'signup' && (
          <Field label="Name" labelVariant="form">
            <Input
              variant="well"
              value={name}
              onChange={(e) => setNameField(e.target.value)}
              placeholder="Kevin"
              autoComplete="name"
            />
          </Field>
        )}
        {mode !== 'reset' && (
          <Field label="Email" labelVariant="form">
            <Input
              variant="well"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </Field>
        )}
        {mode !== 'forgot' && (
          <Field label={mode === 'reset' ? 'New password' : 'Password'} labelVariant="form">
            <Input
              variant="well"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'signin' ? '••••••••' : 'At least 8 characters'}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            />
          </Field>
        )}
        {mode === 'signin' && (
          <Button
            variant="link"
            size="inline"
            className="-mt-1.5 self-end font-normal text-ink-faint hover:text-ink"
            onClick={() => switchMode('forgot')}
          >
            Forgot password?
          </Button>
        )}
        {notice && <Callout>{notice}</Callout>}
        {error && (
          <Callout tone="error">
            {error}
            {suggestMode && (
              <Button
                variant="link"
                size="inline"
                className="mt-1.5 block text-accent-ink underline"
                onClick={() => switchMode(suggestMode)}
              >
                {suggestMode === 'signup' ? 'Create an account instead →' : 'Sign in instead →'}
              </Button>
            )}
            {unverified && (
              <Button
                variant="link"
                size="inline"
                className="mt-1.5 block text-accent-ink underline"
                onClick={resendVerification}
                disabled={busy}
              >
                Resend verification email →
              </Button>
            )}
          </Callout>
        )}
        <Button variant="primary" size="lg" block className="mt-2" type="submit" disabled={busy}>
          {busy
            ? '…'
            : mode === 'signin'
              ? 'Sign in'
              : mode === 'signup'
                ? 'Sign up'
                : mode === 'forgot'
                  ? 'Send reset link'
                  : 'Set new password'}
        </Button>
        <Button
          variant="link"
          size="sm"
          className="p-1.5 text-[13px] font-normal text-ink-faint hover:text-ink"
          onClick={() => switchMode(mode === 'signin' ? 'signup' : 'signin')}
        >
          {mode === 'signin' ? 'No account yet? Sign up' : 'Have an account? Sign in'}
        </Button>
      </AuthCard>
    </AuthScreen>
  )
}
