# Generic OIDC/SSO support

- Issue: https://github.com/kgoedecke/doop/issues/46
- Status: approved by maintainer (kgoedecke), ready for implementation

## Purpose

Let self-hosted doop instances delegate login to an external OIDC identity
provider (Zitadel, Okta, Authentik, Keycloak, etc.) instead of, or alongside,
doop's built-in email/password auth. Proposed and approved as a generic,
env-var-gated feature - not specific to any one IdP or deployment.

## Scope

Single OIDC provider per doop instance, entirely configured by environment
variables. No UI-based provider management, no multi-IdP support - out of
scope, and not what was proposed in issue #46.

Additive: existing email/password login is untouched and stays available.
SSO is an extra option that appears only when configured.

## Approach

better-auth (already in use, v1.6.26) ships two relevant plugins:

- `genericOAuth` (client role) - doop delegates login to an external
  OAuth2/OIDC provider. Supports OIDC discovery via `discoveryUrl`.
- `oidcProvider` - makes doop itself an OIDC issuer. Already used via the
  `mcp()` plugin for agent auth. Wrong direction for this feature.

Use `genericOAuth`, single provider entry (`id: 'oidc'`).

## Configuration

| Env var | Required | Purpose |
|---|---|---|
| `OIDC_ISSUER` | yes (as a set) | Base issuer URL; `${OIDC_ISSUER}/.well-known/openid-configuration` is used for discovery |
| `OIDC_CLIENT_ID` | yes (as a set) | OAuth client id registered with the IdP |
| `OIDC_CLIENT_SECRET` | yes (as a set) | OAuth client secret |
| `OIDC_SCOPES` | no | Space- or comma-separated scopes; default `openid email profile` |
| `OIDC_PROVIDER_NAME` | no | Display name for the login button, e.g. `Zitadel`; default `SSO` |

"Required as a set": if none of `OIDC_ISSUER` / `OIDC_CLIENT_ID` /
`OIDC_CLIENT_SECRET` are set, SSO is simply absent - zero behavior change
for existing installs. If *some but not all three* are set, that's a
misconfiguration and the server throws at boot, same severity as the
existing `BETTER_AUTH_SECRET` production check in `server/auth.ts`.

## Account linking

Confirmed with user: auto-link on matching verified email. If an OIDC
sign-in's email matches an existing password account, and the IdP marks
the email verified, they resolve to the same doop user. This mirrors the
trust model `ADMIN_EMAILS`/`mayPromote()` already uses for
`emailVerified`. No separate "please link your account" flow.

## Components

1. **`server/auth.ts`** - add the `genericOAuth` plugin to `buildAuth()`,
   gated on all three required env vars being set. Provider id `'oidc'`.
   `discoveryUrl` built from `OIDC_ISSUER`. Scopes parsed from
   `OIDC_SCOPES` (space/comma separated), default `openid email profile`.
   Account linking configured to trust the IdP's `email_verified` claim.

2. **`server/auth.ts`** - boot-time validation: partial OIDC config (1 or 2
   of the 3 required vars set) throws a clear error before `betterAuth()`
   is constructed.

3. **New public endpoint**, `GET /api/oidc-config` -> `{ enabled: boolean,
   displayName?: string }`. Needed because the client is a static bundle
   shared across self-hosted deployments - it cannot know at build time
   whether SSO is configured for a given deploy, so it asks at runtime.
   Same fetch-based pattern as the existing `accountExists()` check in
   `AuthPage.tsx`. No secrets in the response.

4. **`src/lib/auth.ts`** - add `genericOAuthClient()` to
   `createAuthClient({ plugins: [...] })`, enabling
   `authClient.signIn.oauth2({ providerId: 'oidc' })`.

5. **`src/pages/AuthPage.tsx`** - on mount, fetch `/api/oidc-config`. If
   enabled, render a "Sign in with {displayName}" button (falls back to
   "Sign in with SSO") above the existing email/password form, with a
   divider. Email/password form remains untouched below it.

6. **`.env.example`** and **`README.md`** - document the five env vars
   above.

## Error handling

- No OIDC env vars set: SSO absent, no behavior change.
- Partial config (1-2 of the 3 required vars): throw at boot.
- Bad `OIDC_ISSUER` (discovery fails): better-auth fetches discovery
  lazily, not at boot, so this surfaces as a sign-in-time error rather than
  a boot crash. Exact behavior to be confirmed against better-auth's
  `genericOAuth` docs during implementation; if boot-time validation is in
  fact possible cheaply, prefer it, but do not block the feature on this -
  document the current behavior either way.

## Testing

TDD, server-only, following the existing convention (`tests/harness.ts`,
real server + real DB, no mocking of better-auth or the IdP). No
client-side test infrastructure exists in this repo yet, so `AuthPage.tsx`
changes are covered by manual smoke test, not automated tests - consistent
with current coverage.

1. `buildAuth()` excludes the OIDC plugin when unset - no regression to
   existing email/password-only behavior.
2. Server throws on boot with partial OIDC config (e.g. `OIDC_ISSUER` set,
   `OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` unset).
3. `GET /api/oidc-config` returns `{ enabled: false }` when unset.
4. `GET /api/oidc-config` returns `{ enabled: true, displayName: ... }`
   when fully configured, respecting `OIDC_PROVIDER_NAME` fallback to
   `"SSO"`.
5. `OIDC_SCOPES` parsing: default value, custom comma-separated value,
   custom space-separated value.

## Out of scope

- Multi-IdP support (would need a config format beyond flat env vars).
- UI-based provider management/admin config.
- Automated client-side (React component) tests - no existing
  infrastructure for this in the repo; would be a separate, unrelated
  addition.
