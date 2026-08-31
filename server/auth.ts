import { betterAuth } from 'better-auth'
import { eq, inArray, or, isNull, ne, and, sql } from 'drizzle-orm'
import { admin, mcp, genericOAuth } from 'better-auth/plugins'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { db } from './db/index.ts'
import * as authSchema from './db/auth-schema.ts'
import { store } from './store.ts'
import * as demo from './demo.ts'
import { mailerConfigured, sendMail } from './mailer.ts'

/**
 * better-auth on our own database: email/password + cookie sessions now;
 * the MCP OAuth plugin (agent identity) lands on top of this instance later.
 */

/** The canonical public origin: OAuth authorize/token/login URLs live here. */
export const PUBLIC_ORIGIN = process.env.BETTER_AUTH_URL || 'http://localhost:4300'

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
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

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
const REQUIRE_VERIFICATION = mailerConfigured && process.env.REQUIRE_EMAIL_VERIFICATION !== 'false'

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
  return process.env.NODE_ENV !== 'production'
}

async function promote(userId: string, email: string): Promise<void> {
  await db.update(authSchema.user).set({ role: 'admin' }).where(eq(authSchema.user.id, userId))
  console.log(`⟡ admin             ${email}`)
}

/** Promote listed users who already exist. Idempotent; runs at boot. */
export async function syncAdmins(): Promise<void> {
  if (!ADMIN_EMAILS.length) return
  if (!mailerConfigured && process.env.NODE_ENV === 'production') {
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
  const { OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_SCOPES, OIDC_PROVIDER_NAME } = process.env
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

/**
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
 * Used as the OIDC provider's mapProfileToUser, which runs before that gate:
 * if the IdP marks this email verified and a local, still-unverified account
 * already holds it, the IdP has already proven ownership — mark the local
 * account verified too, so the gate's own default (matching, verified email)
 * decides the outcome. Also runs the same admin-promotion check syncAdmins
 * and afterEmailVerification already run at the moment a user verifies,
 * since this is exactly that moment for anyone in ADMIN_EMAILS.
 */
async function linkVerifiedOidcEmail(profile: {
  email?: unknown
  email_verified?: unknown
}): Promise<Record<string, never>> {
  const email = typeof profile.email === 'string' ? profile.email.toLowerCase() : undefined
  if (email && profile.email_verified === true) {
    const [existing] = await db
      .select({ id: authSchema.user.id, email: authSchema.user.email })
      .from(authSchema.user)
      .where(and(eq(sql`lower(${authSchema.user.email})`, email), eq(authSchema.user.emailVerified, false)))
    if (existing) {
      await db.update(authSchema.user).set({ emailVerified: true }).where(eq(authSchema.user.id, existing.id))
      if (mayPromote({ email: existing.email, emailVerified: true })) await promote(existing.id, existing.email)
    }
  }
  return {}
}

function buildAuth() {
  const oidc = loadOidcConfig()
  if (!process.env.BETTER_AUTH_SECRET && process.env.NODE_ENV === 'production') {
    throw new Error('BETTER_AUTH_SECRET must be set in production')
  }
  const prod = process.env.NODE_ENV === 'production'
  if (prod && !process.env.BETTER_AUTH_URL) {
    throw new Error('BETTER_AUTH_URL (the public origin, e.g. https://doop.app) must be set in production')
  }
  return betterAuth({
    /* the public origin — OAuth discovery/authorize/token URLs are built on
       it, so in dev it must be the web port that proxies /api and /mcp */
    baseURL: PUBLIC_ORIGIN,
    secret: process.env.BETTER_AUTH_SECRET || 'doop-dev-secret-not-for-production',
    /* prod: the public origin, plus any extras from env. dev: trust whichever
       origin the request came from (localhost, 127.0.0.1, LAN IP — all fine). */
    trustedOrigins: prod
      ? [PUBLIC_ORIGIN, ...(process.env.TRUSTED_ORIGINS || '').split(',').filter(Boolean)]
      : (request) => {
          const origin = request?.headers.get('origin')
          return origin ? [origin] : []
        },
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
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
      },
      sendVerificationEmail: async ({ user, url }) => {
        await sendMail({
          to: user.email,
          subject: 'Verify your doop email',
          text: `Hi ${user.name || 'there'},\n\nConfirm this email address to activate your doop account:\n\n${url}\n\nIf you didn't sign up for doop, ignore this email.`,
        })
      },
    },
    /* onboarding: every new user gets a canvas, and the demo agent performs
       on it the first time they arrive (see server/demo.ts) */
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            const first = (user.name || 'Your').split(/\s+/)[0]
            const canvas = store.createCanvas(`${first}'s first canvas`, user.id)
            demo.markPending(canvas.id)
            /* the other half of the ADMIN_EMAILS reconcile: syncAdmins covers
               people who already existed at boot, this covers signups after.
               With SMTP on, a fresh signup is never verified yet, so the
               promotion happens in afterEmailVerification instead. */
            if (mayPromote(user)) await promote(user.id, user.email)
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
       loadOidcConfig() finds a full config. discoveryUrl resolves the
       authorize/token endpoints lazily at sign-in time, so an unreachable
       issuer surfaces there rather than at boot.
       Account linking (see linkVerifiedOidcEmail below): better-auth's own
       default linking gate requires BOTH the IdP's email_verified claim AND
       the local user row already being emailVerified — the second half is
       unreachable on an SMTP-less instance, where no local account ever
       verifies on its own. mapProfileToUser flips that local flag first,
       so the gate's own default (matching, IdP-verified email) is what
       actually decides linking, as intended. */
    plugins: [
      mcp({ loginPage: '/' }),
      admin({ impersonationSessionDuration: 15 * 60 }),
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
                  mapProfileToUser: linkVerifiedOidcEmail,
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
