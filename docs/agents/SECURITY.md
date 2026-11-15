# Security review (ArcticSlayy/doop fork)

Date: 2026-11-14. Method: static review plus `bun audit` and pattern scans, with no server run and nothing installed
(the lockfile is read as is). Scope: upstream `kgoedecke/doop` at `2b257e2b8`, which the fork carries. Nothing here
is a fork-introduced change; the fork's only code additions are `.github/workflows/sync-upstream.yml` and docs.

## Summary

| Area                    | Result                                                                            |
| ----------------------- | --------------------------------------------------------------------------------- |
| Dependency audit        | 105 advisories (4 critical, 33 high, 54 moderate, 14 low). Report only, see below |
| Secret scan, tree       | Clean: only documentation placeholders and test fixtures                          |
| Secret scan, history    | Clean: 548 commits, no key/token patterns; only `.env.example` ever committed     |
| Auth and OAuth handling | No exploitable finding; two hardening notes                                       |
| AGPL notices            | Intact                                                                            |

## Dependency audit (`bun audit`, report only)

Critical advisories and whether Doop's own use reaches them:

| Package     | Advisory                                                                 | Reachable in Doop?                                                                                 |
| ----------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| better-auth | GHSA-965c-763c-88jm: OAuth state usable as a Magic Link (fixed in 1.7.7) | No: the magic-link plugin is not used (plugins are `mcp`, `admin`, `oneTimeToken`, `genericOAuth`) |
| dompurify   | GHSA-cg2g-xh64-v4q7: `SAFE_FOR_TEMPLATES` bypass                         | No direct use: not imported by `src/`, `server/` or `shared/` (transitive)                         |
| proxy-addr  | GHSA-jqcg-44mw-7w3h: IPv4-mapped IPv6 trust-subnet spoofing              | No: `app.set('trust proxy', 1)` is a hop count, not a subnet list                                  |
| shell-quote | GHSA-pqg4-j6r4-53mv: `quote()` command injection                         | No: dev-only, pulled in by `concurrently`                                                          |

Other high-severity packages (transitive unless noted): `@modelcontextprotocol/sdk` (direct, pinned 1.12.0),
`body-parser`, `brace-expansion`, `fast-uri`, `happy-dom` (tests), `nodemailer`, `sharp`, `source-map-js`,
`systeminformation`, `undici`, `zod`. The full JSON is regenerated with `bun audit --json`.

Recommendation, not done: the fork tracks upstream, so a local dependency bump would conflict with every upstream
`package.json` / `bun.lock` change. Prefer upstream taking these (open an issue or PR there only if Arctic asks). If we
ever bump here, do it as one PR with a Sol review and a green CI, starting with better-auth 1.7.7 and
`@modelcontextprotocol/sdk`, which are the two direct dependencies.

## Secret scan

- Tree: `git grep` for AWS, GitHub, Anthropic, OpenAI-style, Slack, Google and Stripe key shapes and PEM headers. Hits
  are `ios/README.md` (an APNs key placeholder with `...`) and `tests/` fixtures (`sk-ant-test-only-...`, `xoxb-test-...`,
  an obviously fake `AIza...` string).
- History: `git log -G` over all refs for the same patterns, and a file-name sweep for `.env*`, `.pem`, `.p12`, `.key`,
  `id_rsa`, `.keystore`. Only `.env.example` appears.
- Limits: pattern based, with no entropy analysis (no gitleaks or trufflehog installed). Re-run if one is added.

## Auth and OAuth handling (`server/auth.ts`, `server/index.ts`, `server/meta.ts`, `server/githubApp.ts`)

Good:

- `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` are required in production (a missing one fails at boot in `server/env.ts`);
  the insecure dev default is dev-only.
- `trustedOrigins` in production is the public origin plus explicit env extras (and Apple's origin only when its web
  flow is on); only dev trusts the request's own origin. This is better-auth's CSRF and origin gate.
- Social and SSO tokens are sealed (`account.encryptOAuthTokens`); user credentials (model keys, integration tokens)
  are AES-256-GCM sealed at rest (`server/secretBox.ts`).
- SSO uses PKCE. Signed-in handoffs use short-lived, single-use, hashed tokens (`oneTimeToken`, 2 minutes).
- Third-party OAuth `state` values (Meta, GitHub app) are HMAC-signed with an expiry and a user binding; Meta's is
  compared with `timingSafeEqual` and the callback checks `state.userId === userId`.
- MCP OAuth: 1 hour access tokens, 30 day refresh tokens; consent goes through a code bound to the signed-in account
  (`/api/mcp-consent/:code`, `Cache-Control: no-store`, disabled clients refused). Banned users are checked on every
  MCP call, since a token outlives a ban.
- Redirect targets: `AuthPage` passes `redirect_to` through `safeRelativeTarget`; server redirects are fixed internal
  paths or the app's own install URL.
- `Access-Control-Allow-Origin: *` appears only on `/a/` assets (public by unguessable id) and the cookieless
  ingest endpoint, both commented and appropriate.

Hardening notes (not vulnerabilities):

1. MCP refresh tokens are neither rotated nor revoked by the plugin (documented upstream in `server/mcpTokens.ts`);
   a stolen refresh token lives up to 30 days. Revoking a connection is the account's only remedy.
2. `requireEmailVerification` depends on SMTP being configured; an SMTP-less self-host trusts unverified emails (the
   code documents it). Irrelevant while the fork is not self-hosted.

Not reviewed: the Rust desktop shell, the iOS app, billing, and every REST route's role check (routes are written so a
missing `need` role does not compile, which is a good sign).

## AGPL notices

- `LICENSE` is the AGPL-3.0 text, unmodified. `README.md` carries the license section, `CLA.md` and `CONTRIBUTING.md`
  are present, and `cursor-plugin/LICENSE` ships with the plugin.
- Upstream source files carry no per-file SPDX headers, so none were removed. The fork changes no upstream file, so
  nothing of ours needs a header; new fork files are docs and one workflow.
- AGPL section 13: a network-hosted modified fork must offer its source. The fork is public and personal-use only,
  so this is satisfied while the repository stays public.
