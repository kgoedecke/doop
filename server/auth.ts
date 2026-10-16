import { env } from './env.ts'
import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { eq, inArray, or, isNull, ne, and, sql } from 'drizzle-orm'
import { admin, mcp, genericOAuth, oneTimeToken } from 'better-auth/plugins'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { db } from './db/index.ts'
import * as authSchema from './db/auth-schema.ts'
import { store } from './store.ts'
import * as demo from './demo.ts'
import { mailerConfigured, sendMail } from './mailer.ts'
import { acceptInvites } from './workspaces.ts'
import { purgeUserData } from './accountDeletion.ts'
import { createHash } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'

/**
 * better-auth on our own database: email/password + cookie sessions now;
 * the MCP OAuth plugin (agent identity) lands on top of this instance later.
 */

/**
 * Who gets the admin role, by email. Ids can't do this job: on a fresh
 * deploy nobody has an id until they sign up, which would mean a redeploy
 * to name the first admin. Emails are known in advance, so this reconciles
 * into user.role at signup and at boot, and everything downstream — this
 * plugin's own ban/impersonate endpoints included — reads only the role.
 *
 * Deliberately one-way: dropping an email here does not demote anyone.
 * Demotion is an explicit setRole, so there's an actor behind it.
 */
const ADMIN_EMAILS = env.ADMIN_EMAILS.map((s) => s.toLowerCase())

/** Empty means public signup; otherwise only exact email domains may register. */
const SIGNUP_EMAIL_DOMAINS = env.SIGNUP_EMAIL_DOMAINS.map((s) => s.toLowerCase().replace(/^@/, '')).filter(Boolean)

/**
 * Whether an unverified account may sign in. Set REQUIRE_EMAIL_VERIFICATION
 * to "false" to let people use doop the moment they sign up — fewer people
 * fall out of the funnel at a "check your inbox" screen, at the cost of
 * letting anyone hold an address they don't own.
 *
 * The verification email still goes out either way: it becomes optional
 * rather than absent, which keeps the ADMIN_EMAILS path below intact. An
 * admin-to-be clicks the link once; nobody else has to.
 */
const REQUIRE_VERIFICATION = mailerConfigured && env.REQUIRE_EMAIL_VERIFICATION

/**
 * An email address only identifies someone once they have PROVEN they own it.
 * Without SMTP nothing can ever be verified and signup is open (see
 * requireEmailVerification below), so an unguarded ADMIN_EMAILS would hand
 * the admin role to whoever signs up with the address first — a stranger can
 * type your email as easily as you can. Outside development we therefore
 * refuse to promote at all rather than promote an unproven claim.
 */
function mayPromote(user: { email: string; emailVerified: boolean }): boolean {
  if (!ADMIN_EMAILS.includes(user.email.toLowerCase())) return false
  if (user.emailVerified) return true
  if (mailerConfigured) return false // verification is possible — wait for it
  return !env.isProduction
}

async function promote(userId: string, email: string): Promise<void> {
  await db.update(authSchema.user).set({ role: 'admin' }).where(eq(authSchema.user.id, userId))
  console.log(`⟡ admin             ${email}`)
}

/** Promote listed users who already exist. Idempotent; runs at boot. */
export async function syncAdmins(): Promise<void> {
  if (!ADMIN_EMAILS.length) return
  if (!mailerConfigured && env.isProduction) {
    console.warn(
      '⚠ ADMIN_EMAILS is set but no SMTP is configured, so email ownership cannot be verified and nobody will be promoted. Configure SMTP_HOST, or set the admin role directly in the database.',
    )
    return
  }
  /* lower() on both sides: the signup path compares case-insensitively, and
     an admin who silently isn't one because their address was capitalised is
     the kind of bug nobody thinks to look for */
  const candidates = await db
    .select({ id: authSchema.user.id, email: authSchema.user.email, emailVerified: authSchema.user.emailVerified })
    .from(authSchema.user)
    .where(
      and(
        inArray(sql`lower(${authSchema.user.email})`, ADMIN_EMAILS),
        /* role is NULL on accounts created before the admin plugin landed,
           and `NULL != 'admin'` is NULL — not true — so isNull is required
           or exactly the pre-existing accounts this exists for are skipped */
        or(isNull(authSchema.user.role), ne(authSchema.user.role, 'admin')),
      ),
    )
  for (const u of candidates) {
    if (mayPromote(u)) await promote(u.id, u.email)
    /* Say why, rather than leaving an operator staring at a missing Admin
       button. Common once verification is optional: the account is fine,
       it just never clicked the link. */
    else console.warn(`⚠ ${u.email} is in ADMIN_EMAILS but its email is unverified — not promoted`)
  }
}

interface OidcConfig {
  issuer: string
  clientId: string
  clientSecret: string
  scopes: string[]
  providerName: string
}

/**
 * Env-gated SSO against an external OIDC provider (Zitadel, Okta, Authentik,
 * Keycloak, ...). All three of OIDC_ISSUER/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET
 * must be set together to enable it — a partial set is almost certainly a
 * misconfiguration, not a valid state, so it throws rather than silently
 * running with SSO half-on.
 */
export function loadOidcConfig(): OidcConfig | null {
  const { OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_SCOPES, OIDC_PROVIDER_NAME } = env
  const setCount = [OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET].filter(Boolean).length
  if (setCount === 0) return null
  if (setCount < 3) {
    throw new Error('OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET must all be set together to enable SSO')
  }
  return {
    issuer: OIDC_ISSUER!,
    clientId: OIDC_CLIENT_ID!,
    clientSecret: OIDC_CLIENT_SECRET!,
    scopes: (OIDC_SCOPES || 'openid email profile').split(/[,\s]+/).filter(Boolean),
    providerName: OIDC_PROVIDER_NAME || 'SSO',
  }
}

/** What the login page is allowed to know: whether SSO exists and what to call it. Never the secret. */
export function oidcPublicConfig(): { enabled: boolean; displayName?: string } {
  const config = loadOidcConfig()
  return config ? { enabled: true, displayName: config.providerName } : { enabled: false }
}

interface OAuthClient {
  clientId: string
  clientSecret: string
}

/**
 * The <PREFIX>_CLIENT_ID / <PREFIX>_CLIENT_SECRET pair behind each social
 * provider. Same all-or-nothing rule as loadOidcConfig: both set enables
 * the provider, neither leaves it off, and a half-set pair refuses to boot
 * rather than showing a button that can never complete.
 */
function loadOAuthClient(prefix: 'GOOGLE' | 'MICROSOFT' | 'APPLE', label: string): OAuthClient | null {
  const clientId = env[`${prefix}_CLIENT_ID`]
  const clientSecret = env[`${prefix}_CLIENT_SECRET`]
  const setCount = [clientId, clientSecret].filter(Boolean).length
  if (setCount === 0) return null
  if (setCount < 2) {
    throw new Error(`${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET must both be set to enable ${label} sign-in`)
  }
  return { clientId: clientId!, clientSecret: clientSecret! }
}

/** Env-gated "Sign in with Google", alongside email/password and OIDC SSO. */
export function loadGoogleConfig(): OAuthClient | null {
  return loadOAuthClient('GOOGLE', 'Google')
}

interface MicrosoftConfig extends OAuthClient {
  /** Entra tenant: `common` (any Microsoft account, the default), `organizations`, `consumers`, or a tenant id. */
  tenantId: string
}

/**
 * Env-gated "Sign in with Microsoft" (Entra ID / personal Microsoft
 * accounts). MICROSOFT_TENANT_ID narrows who may sign in: leave it at
 * `common` for a public instance, set your tenant id to make the button an
 * org-only door.
 */
export function loadMicrosoftConfig(): MicrosoftConfig | null {
  const client = loadOAuthClient('MICROSOFT', 'Microsoft')
  return client && { ...client, tenantId: env.MICROSOFT_TENANT_ID }
}

export interface AppleConfig {
  /** Services ID + client-secret JWT: the browser "Sign in with Apple" button. Null on a native-only setup. */
  web: OAuthClient | null
  /** The iOS app's bundle id: identity tokens it obtains natively carry it as their audience. */
  appBundleIdentifier: string | null
}

/**
 * Env-gated "Sign in with Apple". Two halves, each optional on its own:
 * APPLE_CLIENT_ID / APPLE_CLIENT_SECRET (all-or-nothing, like the other
 * pairs) put the button on the web login page; APPLE_APP_BUNDLE_IDENTIFIER
 * lets the iOS app sign in with the identity token it gets from the native
 * Sign in with Apple sheet (POST /api/auth/sign-in/social with idToken),
 * which Apple issues for the bundle id rather than the Services ID.
 */
export function loadAppleConfig(): AppleConfig | null {
  const web = loadOAuthClient('APPLE', 'Apple')
  const appBundleIdentifier = env.APPLE_APP_BUNDLE_IDENTIFIER ?? null
  if (!web && !appBundleIdentifier) return null
  return { web, appBundleIdentifier }
}

const APPLE_ISSUER = 'https://appleid.apple.com'

/**
 * Verifies an identity token from the iOS app's native Sign in with Apple
 * sheet: Apple's signature (keys from APPLE_JWKS_URL, cached by jose),
 * Apple as issuer, the app's bundle id as audience, at most an hour old,
 * and the nonce the app says it used — Apple stores its SHA-256 in the
 * token, so either the hash or (should Apple ever pass it through) the raw
 * value matches. A token carrying a nonce the app did not claim is refused
 * too: that is a token minted for some other sign-in.
 *
 * Owned here rather than left to better-auth's built-in check (which does
 * the same, against a hardcoded key URL) so the suite can stand up its own
 * keys and drive the real endpoint; see tests/appleSignIn.test.ts.
 */
export function appleIdentityTokenVerifier(
  audience: string,
  jwksUrl = env.APPLE_JWKS_URL,
): (token: string, nonce: string | undefined) => Promise<boolean> {
  const keys = createRemoteJWKSet(new URL(jwksUrl))
  return async (token, nonce) => {
    try {
      const { payload } = await jwtVerify(token, keys, { issuer: APPLE_ISSUER, audience, maxTokenAge: '1h' })
      const claimed = typeof payload.nonce === 'string' ? payload.nonce : undefined
      if (claimed === undefined && nonce === undefined) return true
      if (claimed === undefined || nonce === undefined) return false
      return claimed === nonce || claimed === createHash('sha256').update(nonce).digest('hex')
    } catch {
      return false
    }
  }
}

/** Everything the login page needs to render its provider buttons. Never a secret. */
export function loginProvidersConfig(): {
  enabled: boolean
  displayName?: string
  google: boolean
  microsoft: boolean
  /** browser "Sign in with Apple" */
  apple: boolean
  /** the iOS app's native Sign in with Apple */
  appleNative: boolean
} {
  const apple = loadAppleConfig()
  return {
    ...oidcPublicConfig(),
    google: loadGoogleConfig() !== null,
    microsoft: loadMicrosoftConfig() !== null,
    apple: apple?.web != null,
    appleNative: apple?.appBundleIdentifier != null,
  }
}

/**
 * Shared by every external identity provider doop signs people in through
 * (the OIDC SSO plugin and the Google and Microsoft social providers — each
 * hands this its raw profile: `email` + `email_verified`, or for Microsoft,
 * which only sends email_verified when the app registration asks for it,
 * the `verified_primary_email` optional claim listing addresses the account
 * has proven; better-auth reads exactly the same two signals).
 *
 * better-auth's account-linking gate requires the LOCAL user row to already
 * be emailVerified before it will link an incoming OAuth sign-in to it —
 * the IdP's own emailVerified claim alone is not enough (see
 * link-account.mjs's requireLocalEmailVerified, which defaults true and, per
 * its own deprecation note, is headed toward becoming unconditional). On an
 * instance with no SMTP configured, no local account can ever verify on its
 * own (see mailerConfigured in mailer.ts), so without this, an existing
 * password user could never link their account to SSO — exactly the
 * migration this feature exists to support.
 *
 * Used as each provider's mapProfileToUser, which runs before that gate:
 * if the IdP marks this email verified and a local, still-unverified account
 * already holds it, the IdP has already proven ownership — mark the local
 * account verified too, so the gate's own default (matching, verified email)
 * decides the outcome.
 *
 * Deliberately does NOT run the ADMIN_EMAILS promotion check here, unlike
 * syncAdmins and afterEmailVerification: any configured IdP would otherwise
 * become a trust root for the admin role, which is exactly what mayPromote
 * exists to prevent (a public/open-registration IdP can assert
 * email_verified for an address it never confirmed ownership of just as
 * cheaply as a stranger typing it into a password signup). It also runs
 * before better-auth's own linking gate, so a grant here would persist even
 * if the sign-in then fails to link. Promotion for an SSO-linked ADMIN_EMAILS
 * account still happens — once, safely — the next time syncAdmins runs at
 * boot, since this handler leaves emailVerified true.
 */
async function linkVerifiedProviderEmail(profile: {
  email?: unknown
  email_verified?: unknown
  verified_primary_email?: unknown
}): Promise<Record<string, never>> {
  const email = typeof profile.email === 'string' ? profile.email.toLowerCase() : undefined
  const verifiedPrimary = Array.isArray(profile.verified_primary_email) ? profile.verified_primary_email : []
  /* Apple's identity token carries email_verified as the string "true" as
     often as the boolean (its docs allow both) */
  const verified =
    profile.email_verified === true ||
    profile.email_verified === 'true' ||
    verifiedPrimary.some((candidate) => typeof candidate === 'string' && candidate.toLowerCase() === email)
  if (email && verified) {
    const [existing] = await db
      .select({ id: authSchema.user.id })
      .from(authSchema.user)
      .where(and(eq(sql`lower(${authSchema.user.email})`, email), eq(authSchema.user.emailVerified, false)))
    if (existing) {
      await db.update(authSchema.user).set({ emailVerified: true }).where(eq(authSchema.user.id, existing.id))
    }
  }
  return {}
}

/**
 * SIGNUP_EMAIL_DOMAINS, enforced where every sign-up path converges — the
 * user row's creation — rather than on the email/password endpoint alone,
 * so an OAuth provider (Google, SSO) can't walk around the allowlist with
 * an address it would have rejected typed in. The email endpoint returns
 * the thrown error as a plain 400; the OAuth callbacks (social and
 * genericOAuth alike, as of better-auth 1.6.26) catch it and redirect back
 * to /auth with the MESSAGE as the ?error= code, spaces turned into
 * underscores — see SIGNUP_RESTRICTED_PREFIX in AuthPage.tsx, which undoes
 * that. Keep the message's first words stable.
 */
function assertSignupDomainAllowed(email: string): void {
  if (!SIGNUP_EMAIL_DOMAINS.length) return
  const lowered = email.toLowerCase()
  const domain = lowered.slice(lowered.lastIndexOf('@') + 1)
  if (SIGNUP_EMAIL_DOMAINS.includes(domain)) return
  throw new APIError('BAD_REQUEST', {
    message: `Sign up is restricted to ${SIGNUP_EMAIL_DOMAINS.map((d) => `@${d}`).join(', ')} email addresses.`,
  })
}

function buildAuth() {
  const oidc = loadOidcConfig()
  const google = loadGoogleConfig()
  const microsoft = loadMicrosoftConfig()
  const apple = loadAppleConfig()
  /* BETTER_AUTH_SECRET and BETTER_AUTH_URL are required in production; a
     missing one fails at boot in server/env.ts */
  const prod = env.isProduction
  return betterAuth({
    /* the public origin — OAuth discovery/authorize/token URLs are built on
       it, so in dev it must be the web port that proxies /api and /mcp */
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    /* prod: the public origin, plus any extras from env, plus Apple when its
       web flow is on: Apple returns the authorization code by POSTing a form
       from appleid.apple.com to /api/auth/callback/apple, and better-auth's
       CSRF check wants that origin trusted. dev: trust whichever origin the
       request came from (localhost, 127.0.0.1, LAN IP — all fine). */
    trustedOrigins: prod
      ? [env.BETTER_AUTH_URL, ...env.TRUSTED_ORIGINS, ...(apple?.web ? ['https://appleid.apple.com'] : [])]
      : (request) => {
          const origin = request?.headers.get('origin')
          return origin ? [origin] : []
        },
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
    /* Social providers, each absent unless its <PREFIX>_* pair is set.
       Google always sends email_verified; Microsoft sends it (or
       verified_primary_email) only if the app registration's optional
       claims include it, otherwise a Microsoft sign-in can only link to an
       already-verified local account. Either way linking goes through
       linkVerifiedProviderEmail exactly as it does for OIDC SSO. */
    socialProviders: {
      ...(google && {
        google: {
          clientId: google.clientId,
          clientSecret: google.clientSecret,
          mapProfileToUser: linkVerifiedProviderEmail,
        },
      }),
      ...(microsoft && {
        microsoft: {
          clientId: microsoft.clientId,
          clientSecret: microsoft.clientSecret,
          tenantId: microsoft.tenantId,
          mapProfileToUser: linkVerifiedProviderEmail,
        },
      }),
      /* Apple: the Services ID pair drives the browser flow; the bundle id is
         the audience better-auth verifies native identity tokens against
         (POST /api/auth/sign-in/social { provider: 'apple', idToken }). A
         native-only setup has no Services ID, so the bundle id stands in as
         the client id (better-auth insists on one) and the secret stays
         empty — nothing but createAuthorizationURL reads it, and that path
         is unreachable without the web button. */
      ...(apple && {
        apple: {
          clientId: apple.web?.clientId ?? apple.appBundleIdentifier!,
          clientSecret: apple.web?.clientSecret ?? '',
          /* native tokens only make sense for a configured bundle id: without
             one, the id-token sign-in is off outright rather than verified
             against the Services ID (which Apple never puts in an app token) */
          disableIdTokenSignIn: !apple.appBundleIdentifier,
          ...(apple.appBundleIdentifier && {
            appBundleIdentifier: apple.appBundleIdentifier,
            verifyIdToken: appleIdentityTokenVerifier(apple.appBundleIdentifier),
          }),
          mapProfileToUser: linkVerifiedProviderEmail,
        },
      }),
    },
    /* Verification is enforced only when an SMTP mailer is configured —
       without one (dev, tiny self-hosts) signup stays open and every email
       is printed to the server log instead, links included — and only when
       REQUIRE_EMAIL_VERIFICATION hasn't been turned off (see above). */
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: REQUIRE_VERIFICATION,
      sendResetPassword: async ({ user, url }) => {
        await sendMail({
          to: user.email,
          subject: 'Reset your doop password',
          text: `Hi ${user.name || 'there'},\n\nSomeone asked to reset the password for this doop account. If that was you, open this link (valid for 1 hour):\n\n${url}\n\nIf it wasn't you, ignore this email — nothing changes.`,
        })
      },
    },
    emailVerification: {
      sendOnSignUp: mailerConfigured,
      autoSignInAfterVerification: true,
      /* the moment ownership is proven is the moment ADMIN_EMAILS may act on
         it — without this, a listed admin would stay unprivileged until the
         next restart picked them up in syncAdmins */
      afterEmailVerification: async (user) => {
        if (mayPromote({ email: user.email, emailVerified: true })) await promote(user.id, user.email)
        /* a verified address is the moment a workspace invite may be honoured */
        await acceptInvites(user.id, user.email)
      },
      sendVerificationEmail: async ({ user, url }) => {
        await sendMail({
          to: user.email,
          subject: 'Verify your doop email',
          text: `Hi ${user.name || 'there'},\n\nConfirm this email address to activate your doop account:\n\n${url}\n\nIf you didn't sign up for doop, ignore this email.`,
        })
      },
    },
    /* self-service account deletion (POST /api/auth/delete-user with the
       password; the iOS app needs it for App Store rule 5.1.1(v)). The user's
       own data goes first so nothing is left pointing at a vanished account. */
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          await purgeUserData(user.id)
        },
      },
    },
    /* onboarding: every new user gets a canvas, and the demo agent performs
       on it the first time they arrive (see server/demo.ts) */
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            assertSignupDomainAllowed(user.email)
          },
          after: async (user) => {
            const first = (user.name || 'Your').split(/\s+/)[0]
            const canvas = store.createCanvas(`${first}'s first canvas`, user.id)
            demo.markPending(canvas.id)
            /* the other half of the ADMIN_EMAILS reconcile: syncAdmins covers
               people who already existed at boot, this covers signups after.
               With SMTP on, a fresh signup is never verified yet, so the
               promotion happens in afterEmailVerification instead. */
            if (mayPromote(user)) await promote(user.id, user.email)
            /* workspace invites are keyed by email: with a mailer they are
               honoured on verification (afterEmailVerification); without one
               nobody can verify, so only local development takes the
               address at face value — production refuses such invites up
               front (workspaces.unknownEmailInvitesAllowed), the line
               ADMIN_EMAILS draws too */
            if (!mailerConfigured && !env.isProduction) await acceptInvites(user.id, user.email)
          },
        },
      },
    },
    /* OAuth provider for MCP clients: agents connect to /mcp with a bearer
       token their human approved in the browser. The SPA login gate lives
       at every path, so "/" works as the login page. */
    /* admin: role/ban/impersonate. 15 minutes rather than the default hour —
       an expired impersonation session doesn't revert to the admin, it signs
       them out entirely, so the window should be short and re-entered. */
    /* genericOAuth: SSO against an external OIDC provider, absent unless
       loadOidcConfig() finds a full config. As of better-auth 1.6.26,
       discoveryUrl resolves the authorize/token endpoints at sign-in time
       rather than at plugin registration, so an unreachable issuer tends to
       surface there rather than at boot — an implementation detail of this
       version, not a documented contract, so don't rely on it.
       pkce: true because some IdPs reject a non-PKCE authorization code flow.
       Account linking (see linkVerifiedProviderEmail above): better-auth's own
       default linking gate requires BOTH the IdP's email_verified claim AND
       the local user row already being emailVerified — the second half is
       unreachable on an SMTP-less instance, where no local account ever
       verifies on its own. mapProfileToUser flips that local flag first,
       so the gate's own default (matching, IdP-verified email) is what
       actually decides linking, as intended. */
    plugins: [
      mcp({ loginPage: '/' }),
      admin({ impersonationSessionDuration: 15 * 60 }),
      /* oneTimeToken: how a Google / Microsoft / SSO sign-in finished in the
         system browser reaches the desktop app (src/lib/desktopAuth.ts). The
         browser session mints a token, the app redeems it and gets the same
         session's cookie. Single use, hashed at rest, two minutes to live —
         it travels through a doop:// URL that lands in browser history. */
      oneTimeToken({ storeToken: 'hashed', expiresIn: 2 }),
      ...(oidc
        ? [
            genericOAuth({
              config: [
                {
                  providerId: 'oidc',
                  clientId: oidc.clientId,
                  clientSecret: oidc.clientSecret,
                  discoveryUrl: `${oidc.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
                  scopes: oidc.scopes,
                  pkce: true,
                  mapProfileToUser: linkVerifiedProviderEmail,
                },
              ],
            }),
          ]
        : []),
    ],
  })
}

export let auth: ReturnType<typeof buildAuth>

/** Must run after initDb() — the drizzle adapter captures the live db. */
export function initAuth() {
  auth = buildAuth()
}

/* userId -> display name, cached briefly: looked up on every authed MCP
   call, and a short TTL means account renames show up within a minute */
const userNames = new Map<string, { name: string; at: number }>()
const NAME_TTL_MS = 60_000

export async function getUserName(userId: string): Promise<string | undefined> {
  const cached = userNames.get(userId)
  if (cached && Date.now() - cached.at < NAME_TTL_MS) return cached.name
  const [row] = await db
    .select({ name: authSchema.user.name })
    .from(authSchema.user)
    .where(eq(authSchema.user.id, userId))
  if (row?.name) userNames.set(userId, { name: row.name, at: Date.now() })
  return row?.name
}

/* userId -> banned, same short cache: banning revokes browser sessions via
   better-auth, but MCP OAuth tokens stay valid until expiry — this check is
   what actually locks a banned user's agent out, so it runs per MCP call */
const banStates = new Map<string, { banned: boolean; at: number }>()

export async function isBanned(userId: string): Promise<boolean> {
  const cached = banStates.get(userId)
  if (cached && Date.now() - cached.at < NAME_TTL_MS) return cached.banned
  const [row] = await db
    .select({ banned: authSchema.user.banned })
    .from(authSchema.user)
    .where(eq(authSchema.user.id, userId))
  /* an unknown user is treated as banned: a token whose account is gone
     should not keep working */
  const banned = row ? !!row.banned : true
  banStates.set(userId, { banned, at: Date.now() })
  return banned
}
