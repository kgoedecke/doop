import { bool, cleanEnv, EnvMissingError, makeExactValidator, port, str } from 'envalid'
import type { ReporterOptions } from 'envalid'
import { DEFAULT_GEMINI_MODEL, DEFAULT_OPENROUTER_MODEL } from '../shared/modelMenu.ts'

/**
 * Every environment variable the server reads, declared once with its type
 * and default and parsed at boot. A bad value (a port that is not a number, a
 * boolean that is neither true nor false, a missing production secret) fails
 * the process on startup with a message naming the variable, instead of
 * surfacing later as odd behaviour on whichever request first touches it.
 *
 * Call sites read `env.X` and get a typed value. Keep reads where they are:
 * a module-level constant stays module-level, a read inside a function stays
 * inside the function — the second kind is what lets unit tests flip a
 * variable at runtime (see tests/envStub.ts).
 *
 * `.env.example` is the human-facing documentation; tests/env.test.ts checks
 * that every key declared here is listed there.
 *
 * The Gemini cloud worker (server/geminiCloudWorkerMain.ts) is a separate
 * process with its own three variables and does not load this schema.
 */

/* ------------------------------------------------------------------ */
/* custom validators                                                   */
/* ------------------------------------------------------------------ */

/** An absolute http(s) URL with any trailing slash removed, so call sites
 *  can append paths without producing `//`. */
const origin = makeExactValidator<string>((input) => {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    throw new TypeError(`Invalid URL: "${input}"`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`Invalid URL (expected http or https): "${input}"`)
  }
  return input.replace(/\/+$/, '')
})

/** Comma-separated values, trimmed, empties dropped. */
const list = makeExactValidator<string[]>((input) =>
  input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)

const int = (minimum: number) =>
  makeExactValidator<number>((input) => {
    const n = Number(input)
    if (!Number.isInteger(n) || n < minimum) throw new TypeError(`Invalid integer (expected >= ${minimum}): "${input}"`)
    return n
  })

/** A per-minute cap: 0 would refuse every call, so the floor is 1. */
const perMinute = int(1)
const nonNegativeInt = int(0)

/* ------------------------------------------------------------------ */
/* schema                                                              */
/* ------------------------------------------------------------------ */

const schema = {
  NODE_ENV: str({ choices: ['development', 'test', 'production'], default: 'development' }),
  PORT: port({ default: 4400 }),
  /* unset = embedded Postgres (PGlite) under ./data/pg */
  DATABASE_URL: str({ default: undefined }),

  /* ---------------------------------------------------------- auth */
  BETTER_AUTH_SECRET: str({
    devDefault: 'doop-dev-secret-not-for-production',
    desc: 'Signs sessions and OAuth tokens; must be set in production',
  }),
  BETTER_AUTH_URL: origin({
    devDefault: 'http://localhost:4300',
    desc: 'The public origin, e.g. https://doop.app; must be set in production',
  }),
  TRUSTED_ORIGINS: list({ default: [] }),
  SIGNUP_EMAIL_DOMAINS: list({ default: [] }),
  ADMIN_EMAILS: list({ default: [] }),
  REQUIRE_EMAIL_VERIFICATION: bool({ default: true }),
  OIDC_ISSUER: str({ default: undefined }),
  OIDC_CLIENT_ID: str({ default: undefined }),
  OIDC_CLIENT_SECRET: str({ default: undefined }),
  OIDC_SCOPES: str({ default: undefined }),
  OIDC_PROVIDER_NAME: str({ default: undefined }),
  GOOGLE_CLIENT_ID: str({ default: undefined }),
  GOOGLE_CLIENT_SECRET: str({ default: undefined }),
  MICROSOFT_CLIENT_ID: str({ default: undefined }),
  MICROSOFT_CLIENT_SECRET: str({ default: undefined }),
  MICROSOFT_TENANT_ID: str({ default: 'common' }),
  APPLE_CLIENT_ID: str({ default: undefined }),
  APPLE_CLIENT_SECRET: str({ default: undefined }),
  APPLE_APP_BUNDLE_IDENTIFIER: str({ default: undefined }),
  APPLE_JWKS_URL: str({ default: 'https://appleid.apple.com/auth/keys' }),

  /* --------------------------------------------------------- email */
  SMTP_HOST: str({ default: undefined }),
  SMTP_PORT: port({ default: 587 }),
  SMTP_USER: str({ default: undefined }),
  SMTP_PASS: str({ default: undefined }),
  SMTP_SECURE: bool({ default: false }),
  EMAIL_FROM: str({ default: 'doop <no-reply@localhost>' }),

  /* ------------------------------------------------------ webhooks */
  WEBHOOK_ALLOW_PRIVATE_URLS: bool({ default: false }),

  /* ------------------------------------------------ resident agents */
  DOOP_AGENT_PROVIDER: str({ choices: ['anthropic', 'azure'], default: 'anthropic' }),
  ANTHROPIC_API_KEY: str({ default: undefined }),
  AZURE_OPENAI_ENDPOINT: str({ default: undefined }),
  AZURE_OPENAI_API_KEY: str({ default: undefined }),
  AZURE_OPENAI_DEPLOYMENT: str({ default: undefined }),
  AZURE_OPENAI_API_VERSION: str({ default: undefined }),
  AZURE_OPENAI_REASONING_EFFORT: str({ default: undefined }),
  RESIDENT_TASK_LIMIT: nonNegativeInt({ default: 0 }),
  DOOP_AGENT_MODEL: str({ default: 'claude-opus-5' }),
  DOOP_DISTILL_MODEL: str({ default: 'claude-haiku-4-5-20251001' }),
  DOOP_AGENT_OPENAI_MODEL: str({ default: 'gpt-5.6-terra' }),
  DOOP_AGENT_OPENAI_EFFORT: str({ default: 'medium' }),
  DOOP_AGENT_OPENROUTER_MODEL: str({ default: DEFAULT_OPENROUTER_MODEL }),
  DOOP_AGENT_GEMINI_MODEL: str({ default: DEFAULT_GEMINI_MODEL }),
  /* JSON; parsed and shape-checked where it is used so a parse error never
     echoes the worker secrets it contains */
  DOOP_GEMINI_CLOUD_WORKERS: str({ default: undefined }),
  CHATGPT_CONNECT_DISABLED: bool({ default: false }),
  CHATGPT_OAUTH_ISSUER: origin({ default: 'https://auth.openai.com' }),
  CHATGPT_OAUTH_CLIENT_ID: str({ default: 'app_EMoamEEZ73f0CkXaXp7hrann' }),
  CHATGPT_OAUTH_REDIRECT_URI: str({ default: 'http://localhost:1455/auth/callback' }),
  CHATGPT_OAUTH_CALLBACK_PORT: port({ default: 1455 }),
  CHATGPT_AUTH_USER_AGENT: str({ default: 'doop/0.1 (+https://doop.design)' }),
  CHATGPT_DEVICE_URL: str({ default: undefined }),
  CHATGPT_RESPONSES_URL: str({ default: 'https://chatgpt.com/backend-api/codex/responses' }),
  CHATGPT_MODELS_URL: str({ default: 'https://chatgpt.com/backend-api/codex/models' }),
  CHATGPT_MODELS_CLIENT_VERSION: str({ default: '0.163.0' }),
  CHATGPT_ORIGINATOR: str({ default: 'codex_cli_rs' }),
  OPENAI_RESPONSES_URL: str({ default: 'https://api.openai.com/v1/responses' }),
  OPENROUTER_CHAT_URL: str({ default: 'https://openrouter.ai/api/v1/chat/completions' }),
  GEMINI_OPENAI_CHAT_URL: str({
    default: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  }),

  /* ------------------------------------------------ image generation */
  OPENAI_API_KEY: str({ default: undefined }),
  GEMINI_API_KEY: str({ default: undefined }),
  ARK_API_KEY: str({ default: undefined }),
  ARK_IMAGES_URL: str({ default: 'https://ark.ap-southeast.bytepluses.com/api/v3/images/generations' }),
  GEMINI_MODELS_URL: str({ default: 'https://generativelanguage.googleapis.com/v1beta/models' }),
  DOOP_IMAGE_MODEL: str({ default: 'gpt-image-2' }),
  DOOP_IMAGE_ROUTER_MODEL: str({ default: undefined }),

  /* ------------------------------------------------------ integrations */
  META_APP_ID: str({ default: undefined }),
  META_APP_SECRET: str({ default: undefined }),
  LINEAR_CLIENT_ID: str({ default: undefined }),
  LINEAR_CLIENT_SECRET: str({ default: undefined }),
  LINEAR_WEBHOOK_SECRET: str({ default: undefined }),
  LINEAR_API_URL: str({ default: 'https://api.linear.app/graphql' }),
  LINEAR_TOKEN_URL: str({ default: 'https://api.linear.app/oauth/token' }),
  SLACK_CLIENT_ID: str({ default: undefined }),
  SLACK_CLIENT_SECRET: str({ default: undefined }),
  SLACK_SIGNING_SECRET: str({ default: undefined }),
  SLACK_API_URL: str({ default: 'https://slack.com/api' }),
  GITHUB_APP_ID: str({ default: undefined }),
  GITHUB_APP_SLUG: str({ default: undefined }),
  GITHUB_APP_CLIENT_ID: str({ default: undefined }),
  GITHUB_APP_CLIENT_SECRET: str({ default: undefined }),
  GITHUB_APP_PRIVATE_KEY: str({ default: undefined }),
  PEXELS_API_KEY: str({ default: undefined }),
  BRANDFETCH_CLIENT_ID: str({ default: undefined }),
  CONTEXT_DEV_API_KEY: str({ default: undefined }),

  /* ------------------------------------------------- object storage */
  BUCKET: str({ default: undefined }),
  ACCESS_KEY_ID: str({ default: undefined }),
  SECRET_ACCESS_KEY: str({ default: undefined }),
  ENDPOINT: str({ default: undefined }),
  REGION: str({ default: 'auto' }),

  /* -------------------------------------------------------- billing */
  STRIPE_SECRET_KEY: str({ default: undefined }),
  STRIPE_WEBHOOK_SECRET: str({ default: undefined }),
  STRIPE_PRICE_TEAM_MONTHLY: str({ default: undefined }),
  STRIPE_PRICE_TEAM_YEARLY: str({ default: undefined }),

  /* ---------------------------------------------------- screenshots */
  CHROME_PATH: str({ default: undefined }),
  CHROME_NO_SANDBOX: bool({ default: false }),

  /* ------------------------------------------------------ analytics */
  POSTHOG_KEY: str({ default: undefined }),
  VITE_POSTHOG_KEY: str({ default: undefined }),
  POSTHOG_INGEST_HOST: origin({ default: 'https://us.i.posthog.com' }),
  POSTHOG_ASSETS_HOST: origin({ default: 'https://us-assets.i.posthog.com' }),

  /* ---------------------------------------------------- backgrounds */
  BACKGROUNDS_ORIGIN: origin({ default: undefined }),

  /* ---------------------------------------------------- rate limits */
  MCP_UPLOADS_PER_MIN: perMinute({ default: 15 }),
  MCP_SEARCHES_PER_MIN: perMinute({ default: 12 }),
  MCP_GENERATIONS_PER_MIN: perMinute({ default: 6 }),
  MCP_IMPORTS_PER_MIN: perMinute({ default: 5 }),
  SYNC_INGESTS_PER_MIN: perMinute({ default: 30 }),
  PREVIEW_RENDERS_PER_MIN: perMinute({ default: 12 }),
  SYNC_PAGE_INTERVAL_MS: nonNegativeInt({ default: 30_000 }),
  SYNC_FREEZE_MS: nonNegativeInt({ default: 15 * 60_000 }),

  /* ------------------------------------------------------- iOS push */
  DOOP_APNS_TEAM_ID: str({ default: undefined }),
  DOOP_APNS_KEY_ID: str({ default: undefined }),
  DOOP_APNS_PRIVATE_KEY: str({ default: undefined }),
  DOOP_APNS_BUNDLE_ID: str({ default: 'design.doop.ios' }),
}

/** Every declared variable name, for the .env.example coverage test. */
export const ENV_KEYS: readonly string[] = Object.keys(schema)

/* ------------------------------------------------------------------ */
/* parsing                                                             */
/* ------------------------------------------------------------------ */

/** A variable set to the empty string (`X=` in a .env file, an empty
 *  compose `environment:` entry) means unset, not "the empty string":
 *  it takes the default like a missing variable would. */
function presentVars(source: NodeJS.ProcessEnv): Record<string, string> {
  const present: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') present[key] = value
  }
  return present
}

/** Throws one error naming every bad variable, instead of envalid's default
 *  of printing and calling process.exit — an exception carries the message
 *  through tests and through whatever supervises the server process. */
function reporter({ errors }: ReporterOptions<unknown>): void {
  const lines = Object.entries(errors).map(([key, error]) => {
    if (!(error instanceof Error)) return `  ${key}: invalid`
    if (error instanceof EnvMissingError) return `  ${key}: missing${error.message ? ` (${error.message})` : ''}`
    return `  ${key}: ${error.message}`
  })
  if (lines.length) throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`)
}

function parse() {
  const source = presentVars(process.env)
  /* envalid applies devDefault only when NODE_ENV is explicitly set to
     something other than production; doop treats an unset NODE_ENV as
     development (bun run dev, the test harness), so say so */
  source.NODE_ENV ??= 'development'
  return cleanEnv(source, schema, { reporter })
}

export type Env = ReturnType<typeof parse>

/* `let` so reloadEnv can swap the snapshot; ESM live bindings mean every
   importer sees the new one. Nothing outside this file assigns it. */
export let env: Env = parse()

/** Re-read process.env. For tests that change a variable after import;
 *  the server itself parses once at boot. */
export function reloadEnv(): void {
  env = parse()
}
