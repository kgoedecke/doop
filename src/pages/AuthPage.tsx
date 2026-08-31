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

/* Human copy for the OAuth error codes better-auth's callback can redirect
   back with (see redirectOnError in its oauth2 package) — everything else
   falls back to a generic message. account_not_linked is the one an
   operator is most likely to actually hit: an existing local account whose
   email the IdP claims, but that better-auth's own gate refused to link
   (see linkVerifiedOidcEmail in server/auth.ts for why that should now be
   rare, not why it can still happen — a provider that never sends
   email_verified, for instance). */
const SSO_ERROR_MESSAGES: Record<string, string> = {
  account_not_linked:
    'That email already has a doop account that could not be linked automatically — sign in with email/password instead.',
  "email_doesn't_match": "The signed-in email doesn't match the account you started from — try again.",
  email_is_missing: "Your identity provider didn't share an email address — doop needs one to sign you in.",
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

/** Matches server/auth.ts oidcPublicConfig's response shape. */
interface OidcClientConfig {
  enabled: boolean
  displayName?: string
}

/* The client bundle is static and shared across self-hosted deploys — it
   can't know at build time whether the operator configured SSO, so it asks
   the server. See server/auth.ts oidcPublicConfig. */
function useOidcConfig(): OidcClientConfig {
  const [config, setConfig] = useState<OidcClientConfig>({ enabled: false })
  useEffect(() => {
    fetch('/api/oidc-config')
      .then((res) => (res.ok ? res.json() : { enabled: false }))
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
  const [error, setError] = useState<string | null>(null)
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

  /* A failure inside the IdP round trip (the browser has already left and
     come back) redirects here with ?error=<code> rather than throwing where
     ssoSignIn's own res.error check could see it — that check only ever
     catches failures of the *initiating* request (e.g. unknown providerId). */
  useEffect(() => {
    const ssoError = new URLSearchParams(location.search).get('error')
    if (!ssoError) return
    setError(SSO_ERROR_MESSAGES[ssoError] ?? 'SSO sign-in failed — try again or use email/password.')
    history.replaceState(null, '', location.pathname)
  }, [])

  async function ssoSignIn() {
    setError(null)
    setBusy(true)
    try {
      const res = await authClient.signIn.oauth2({
        providerId: 'oidc',
        callbackURL: ssoCallbackURL(),
        errorCallbackURL: '/auth',
      })
      /* success redirects the browser away immediately; only the failure
         case leaves us here to show something */
      if (res.error) setError(res.error.message ?? 'Could not start SSO sign-in — try again or use email/password.')
    } finally {
      setBusy(false)
    }
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
          ? await authClient.signUp.email({ name: name.trim() || email.split('@')[0], email, password })
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
        className="flex w-[min(400px,100%)] flex-col gap-3.5 rounded-[16px] border border-line bg-surface p-6 pt-[30px] shadow-pop sm:p-9 sm:pb-7"
        onSubmit={submit}
      >
        <Wordmark className="mb-1.5" />
        <h1 className="font-display text-[30px] font-semibold leading-[1.1] tracking-[-0.02em]">
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
        {oidc.enabled && (mode === 'signin' || mode === 'signup') && (
          <>
            <Button variant="default" size="lg" block type="button" onClick={ssoSignIn} disabled={busy}>
              {mode === 'signup' ? 'Sign up' : 'Sign in'} with {oidc.displayName}
            </Button>
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
