import { useEffect, useState } from 'react'
import { authClient } from '../lib/auth'
import { setName } from '../lib/identity'
import { posthog } from '../lib/posthog'
import { AuthScreen } from '../components/ui/screen'
import { Wordmark } from '../components/ui/wordmark'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Field } from '../components/ui/field'
import { Callout } from '../components/ui/callout'

/* the auth form's fields sit on paper and soften their focus ring */
const authInput = 'rounded-lg bg-paper focus:border-ink-soft focus:ring-0 md:text-sm'

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

/* Only ever follow a same-origin relative path from a query param. A naive
   startsWith('/') check passes both "//evil.com" (protocol-relative — the
   browser resolves it against the current protocol, landing on a different
   origin) and "/\evil.com" (browsers normalize the backslash to a second
   slash for http(s) URLs, same bypass) — resolving against location.origin
   and comparing origins catches both. */
function safeRelativeTarget(raw: string | null): string | null {
  if (!raw || !raw.startsWith('/')) return null
  try {
    return new URL(raw, location.origin).origin === location.origin ? raw : null
  } catch {
    return null
  }
}

function resumeOAuthFlow(): boolean {
  const params = new URLSearchParams(location.search)
  const target = safeRelativeTarget(params.get('redirect_to') || params.get('redirect_uri'))
  if (target) {
    location.href = target
    return true
  }
  if (params.has('client_id') && params.has('response_type')) {
    location.href = `/api/auth/mcp/authorize${location.search}`
    return true
  }
  return false
}

type AuthMode = 'signin' | 'signup' | 'forgot' | 'reset'

/** Google's four-colour "G", per its sign-in branding guidelines (kept inline: no icon set ships it). */
function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" className="shrink-0">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3c-1.07.72-2.45 1.15-4.06 1.15-3.13 0-5.77-2.11-6.72-4.95H1.28v3.09A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.29A7.2 7.2 0 0 1 4.9 12c0-.8.14-1.57.38-2.29V6.62H1.28a12 12 0 0 0 0 10.76l4-3.09Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.62l4 3.09C6.23 6.88 8.87 4.77 12 4.77Z"
      />
    </svg>
  )
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

/* Where the SSO redirect should land, mirroring resumeOAuthFlow() below —
   but handed to the server as callbackURL rather than navigated to
   directly. The browser leaves for the IdP and returns already carrying a
   session, so this component's own resumeOAuthFlow() never gets to run for
   this path; the equivalent logic has to travel with the request instead. */
function ssoCallbackURL(): string {
  const params = new URLSearchParams(location.search)
  const target = safeRelativeTarget(params.get('redirect_to') || params.get('redirect_uri'))
  if (target) return target
  if (params.has('client_id') && params.has('response_type')) return `/api/auth/mcp/authorize${location.search}`
  return location.pathname + location.search
}

/** Matches server/auth.ts loginProvidersConfig's response shape. */
interface OidcClientConfig {
  enabled: boolean
  displayName?: string
  google: boolean
}

/* The client bundle is static and shared across self-hosted deploys — it
   can't know at build time whether the operator configured SSO, so it asks
   the server. See server/auth.ts loginProvidersConfig. */
function useOidcConfig(): OidcClientConfig {
  const [config, setConfig] = useState<OidcClientConfig>({ enabled: false, google: false })
  useEffect(() => {
    fetch('/api/oidc-config')
      .then((res) => (res.ok ? res.json() : { enabled: false, google: false }))
      .then(setConfig)
      .catch(() => {}) // SSO button just doesn't appear — email/password still works
  }, [])
  return config
}

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
  const [notice, setNotice] = useState<string | null>(null)
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
  async function providerSignIn(start: () => Promise<{ error?: { message?: string } | null }>) {
    setError(null)
    setBusy(true)
    try {
      const res = await start()
      if (res.error) setError(res.error.message ?? 'Could not start sign-in — try again or use email/password.')
    } finally {
      setBusy(false)
    }
  }

  function ssoSignIn() {
    return providerSignIn(() =>
      authClient.signIn.oauth2({ providerId: 'oidc', callbackURL: ssoCallbackURL(), errorCallbackURL: '/auth' }),
    )
  }

  function googleSignIn() {
    return providerSignIn(() =>
      authClient.signIn.social({ provider: 'google', callbackURL: ssoCallbackURL(), errorCallbackURL: '/auth' }),
    )
  }

  async function resendVerification() {
    setBusy(true)
    try {
      await authClient.sendVerificationEmail({ email, callbackURL: '/' })
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
          ? await authClient.signUp.email({ name: name.trim() || email.split('@')[0] || email, email, password })
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
          posthog.capture('account_signed_up')
          setNotice(`Almost there — we sent a verification link to ${email}. Open it to activate your account.`)
          return
        }
        posthog.capture(mode === 'signup' ? 'account_signed_up' : 'account_signed_in')
        setName(res.data.user.name) // keep cursor/feed identity in sync with the account
        if (!resumeOAuthFlow() && mode === 'signup') {
          /* land new users on their auto-created first canvas, where the
             demo agent is waiting to perform */
          try {
            const canvases: { id: string; ownerId?: string }[] = await (await fetch('/api/canvases')).json()
            const own = canvases.find((c) => c.ownerId)
            if (own) location.href = `/c/${own.id}`
          } catch {
            /* fall through to the session-gated re-render */
          }
        }
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthScreen>
      <form
        className="flex w-[min(400px,100%)] flex-col gap-3.5 rounded-[12px] border border-line bg-surface p-6 pt-[30px] shadow-pop sm:p-9 sm:pb-7"
        onSubmit={submit}
      >
        <Wordmark className="mb-1.5" />
        <h1 className="font-serif text-[34px] font-normal leading-[1.05] tracking-[-0.015em]">
          {mode === 'signin' && 'Welcome back.'}
          {mode === 'signup' && 'Create your account.'}
          {mode === 'forgot' && 'Reset your password.'}
          {mode === 'reset' && 'Pick a new password.'}
        </h1>
        <p className="mb-2 text-[14px] leading-[1.5] text-ink-soft">
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
        </p>
        {(oidc.enabled || oidc.google) && (mode === 'signin' || mode === 'signup') && (
          <>
            {oidc.google && (
              <Button variant="default" size="lg" block type="button" onClick={googleSignIn} disabled={busy}>
                <GoogleMark />
                {mode === 'signup' ? 'Sign up' : 'Sign in'} with Google
              </Button>
            )}
            {oidc.enabled && (
              <Button variant="default" size="lg" block type="button" onClick={ssoSignIn} disabled={busy}>
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
              className={authInput}
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
              className={authInput}
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
              className={authInput}
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
            size="sm"
            className="-mt-1.5 self-end px-0 py-0 text-xs font-normal text-ink-faint hover:text-ink"
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
                size="sm"
                className="mt-1.5 block px-0 py-0 text-accent-ink underline underline-offset-[3px]"
                onClick={() => switchMode(suggestMode)}
              >
                {suggestMode === 'signup' ? 'Create an account instead →' : 'Sign in instead →'}
              </Button>
            )}
            {unverified && (
              <Button
                variant="link"
                size="sm"
                className="mt-1.5 block px-0 py-0 text-accent-ink underline underline-offset-[3px]"
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
      </form>
    </AuthScreen>
  )
}
