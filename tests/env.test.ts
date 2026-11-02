import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENV_KEYS, env, reloadEnv } from '../server/env.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/**
 * The one place environment variables are parsed. What matters here is the
 * contract call sites rely on: a wrong value fails loudly and names itself, a
 * blank value means unset, and the documentation keeps up with the schema.
 */

afterEach(unstubAllEnvs)

describe('server/env.ts', () => {
  it('parses numbers, booleans, lists and origins', () => {
    stubEnv('MCP_UPLOADS_PER_MIN', '2')
    stubEnv('WEBHOOK_ALLOW_PRIVATE_URLS', '1')
    stubEnv('TRUSTED_ORIGINS', ' https://a.example, https://b.example ,')
    stubEnv('BETTER_AUTH_URL', 'https://doop.example/')
    expect(env.MCP_UPLOADS_PER_MIN).toBe(2)
    expect(env.WEBHOOK_ALLOW_PRIVATE_URLS).toBe(true)
    expect(env.TRUSTED_ORIGINS).toEqual(['https://a.example', 'https://b.example'])
    expect(env.BETTER_AUTH_URL).toBe('https://doop.example')
  })

  it('treats a blank value as unset and applies the default', () => {
    stubEnv('MCP_UPLOADS_PER_MIN', '')
    stubEnv('SMTP_SECURE', '   ')
    stubEnv('OPENAI_API_KEY', '')
    expect(env.MCP_UPLOADS_PER_MIN).toBe(15)
    expect(env.SMTP_SECURE).toBe(false)
    expect(env.OPENAI_API_KEY).toBeUndefined()
  })

  it('refuses a bad value at parse time and names the variable', () => {
    /* a typo used to become NaN and silently switch the limit off */
    expect(() => stubEnv('MCP_UPLOADS_PER_MIN', '1O')).toThrow(/MCP_UPLOADS_PER_MIN: Invalid integer/)
    expect(() => stubEnv('MCP_UPLOADS_PER_MIN', '0')).toThrow(/MCP_UPLOADS_PER_MIN/)
    stubEnv('MCP_UPLOADS_PER_MIN', undefined)
    expect(() => stubEnv('SMTP_SECURE', 'maybe')).toThrow(/SMTP_SECURE: Invalid bool/)
    stubEnv('SMTP_SECURE', undefined)
    expect(() => stubEnv('BETTER_AUTH_URL', 'doop.example')).toThrow(/BETTER_AUTH_URL: Invalid URL/)
    stubEnv('BETTER_AUTH_URL', undefined)
    expect(() => stubEnv('DOOP_AGENT_PROVIDER', 'openai')).toThrow(/DOOP_AGENT_PROVIDER/)
  })

  it('reports every bad variable in one error', () => {
    vi.stubEnv('PORT', 'eighty')
    vi.stubEnv('CHROME_NO_SANDBOX', 'yes please')
    expect(() => reloadEnv()).toThrow(/PORT: .*\n.*CHROME_NO_SANDBOX: /)
  })

  it('defaults an unset NODE_ENV to development', () => {
    vi.stubEnv('NODE_ENV', undefined)
    reloadEnv()
    expect(env.NODE_ENV).toBe('development')
    expect(env.isDev).toBe(true)
    expect(env.isProduction).toBe(false)
  })

  it('requires the auth secret and public origin in production only', () => {
    vi.stubEnv('BETTER_AUTH_SECRET', undefined)
    vi.stubEnv('BETTER_AUTH_URL', undefined)
    reloadEnv()
    expect(env.BETTER_AUTH_SECRET).toBe('doop-dev-secret-not-for-production')
    expect(env.BETTER_AUTH_URL).toBe('http://localhost:4300')

    vi.stubEnv('NODE_ENV', 'production')
    expect(() => reloadEnv()).toThrow(/BETTER_AUTH_SECRET: missing[\s\S]*BETTER_AUTH_URL: missing/)

    vi.stubEnv('BETTER_AUTH_SECRET', 'a-real-secret')
    vi.stubEnv('BETTER_AUTH_URL', 'https://doop.example')
    reloadEnv()
    expect(env.isProduction).toBe(true)
  })

  it('throws on a variable nobody declared, so a typo cannot read as unset', () => {
    expect(() => (env as unknown as Record<string, unknown>).MCP_UPLOAD_PER_MIN).toThrow(/MCP_UPLOAD_PER_MIN/)
  })

  it('documents every declared variable in .env.example', () => {
    const example = ['../.env.example'].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n')
    const documented = new Set([...example.matchAll(/^#?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]))
    expect(ENV_KEYS.filter((key) => !documented.has(key))).toEqual([])
  })
})
