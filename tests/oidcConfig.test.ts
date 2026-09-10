import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadGoogleConfig, loadOidcConfig, loginProvidersConfig, oidcPublicConfig } from '../server/auth.ts'

/**
 * Pure config-parsing/validation, no server spawn needed - same pattern as
 * tests/publicUrl.test.ts. The HTTP-facing side (GET /api/oidc-config) is
 * covered separately in tests/oidc.test.ts against a real server.
 */

const OIDC_VARS = [
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_SCOPES',
  'OIDC_PROVIDER_NAME',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of OIDC_VARS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of OIDC_VARS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

function setRequiredOidcEnv(): void {
  process.env.OIDC_ISSUER = 'https://idp.example.com'
  process.env.OIDC_CLIENT_ID = 'client-abc'
  process.env.OIDC_CLIENT_SECRET = 'secret-xyz'
}

describe('loadOidcConfig', () => {
  it('returns null when none of the required vars are set', () => {
    expect(loadOidcConfig()).toBeNull()
  })

  it.each([
    { OIDC_ISSUER: 'https://idp.example.com' },
    { OIDC_CLIENT_ID: 'abc' },
    { OIDC_ISSUER: 'https://idp.example.com', OIDC_CLIENT_ID: 'abc' },
    { OIDC_CLIENT_ID: 'abc', OIDC_CLIENT_SECRET: 'shh' },
  ])('throws when only some required vars are set: %o', (partial) => {
    Object.assign(process.env, partial)
    expect(() => loadOidcConfig()).toThrow(/OIDC_ISSUER.*OIDC_CLIENT_ID.*OIDC_CLIENT_SECRET/)
  })

  it('returns a full config with default scopes and provider name when all three required vars are set', () => {
    setRequiredOidcEnv()

    expect(loadOidcConfig()).toEqual({
      issuer: 'https://idp.example.com',
      clientId: 'client-abc',
      clientSecret: 'secret-xyz',
      scopes: ['openid', 'email', 'profile'],
      providerName: 'SSO',
    })
  })

  it('parses comma-separated OIDC_SCOPES', () => {
    setRequiredOidcEnv()
    process.env.OIDC_SCOPES = 'openid,email,groups'

    expect(loadOidcConfig()?.scopes).toEqual(['openid', 'email', 'groups'])
  })

  it('parses space-separated OIDC_SCOPES', () => {
    setRequiredOidcEnv()
    process.env.OIDC_SCOPES = 'openid email groups'

    expect(loadOidcConfig()?.scopes).toEqual(['openid', 'email', 'groups'])
  })

  it('uses OIDC_PROVIDER_NAME as the provider name when set', () => {
    setRequiredOidcEnv()
    process.env.OIDC_PROVIDER_NAME = 'Zitadel'

    expect(loadOidcConfig()?.providerName).toBe('Zitadel')
  })
})

describe('oidcPublicConfig', () => {
  it('reports disabled with no other fields when unset', () => {
    expect(oidcPublicConfig()).toEqual({ enabled: false })
  })

  it('reports enabled with the display name when configured', () => {
    setRequiredOidcEnv()
    process.env.OIDC_PROVIDER_NAME = 'Zitadel'

    expect(oidcPublicConfig()).toEqual({ enabled: true, displayName: 'Zitadel' })
  })

  it('falls back to "SSO" as the display name when OIDC_PROVIDER_NAME is unset', () => {
    setRequiredOidcEnv()

    expect(oidcPublicConfig()).toEqual({ enabled: true, displayName: 'SSO' })
  })

  it('never leaks the client secret', () => {
    setRequiredOidcEnv()

    expect(JSON.stringify(oidcPublicConfig())).not.toContain('secret-xyz')
  })
})

describe('loadGoogleConfig', () => {
  it('returns null when neither var is set', () => {
    expect(loadGoogleConfig()).toBeNull()
  })

  it.each([{ GOOGLE_CLIENT_ID: 'g-client' }, { GOOGLE_CLIENT_SECRET: 'g-secret' }])(
    'throws when only one of the pair is set: %o',
    (partial) => {
      Object.assign(process.env, partial)
      expect(() => loadGoogleConfig()).toThrow(/GOOGLE_CLIENT_ID.*GOOGLE_CLIENT_SECRET/)
    },
  )

  it('returns the pair when both are set', () => {
    process.env.GOOGLE_CLIENT_ID = 'g-client'
    process.env.GOOGLE_CLIENT_SECRET = 'g-secret'

    expect(loadGoogleConfig()).toEqual({ clientId: 'g-client', clientSecret: 'g-secret' })
  })
})

describe('loginProvidersConfig', () => {
  it('reports both providers off when nothing is configured', () => {
    expect(loginProvidersConfig()).toEqual({ enabled: false, google: false })
  })

  it('reports google on, independently of SSO, and never the secret', () => {
    process.env.GOOGLE_CLIENT_ID = 'g-client'
    process.env.GOOGLE_CLIENT_SECRET = 'g-secret'

    expect(loginProvidersConfig()).toEqual({ enabled: false, google: true })
    expect(JSON.stringify(loginProvidersConfig())).not.toContain('g-secret')
  })

  it('combines SSO and google', () => {
    setRequiredOidcEnv()
    process.env.GOOGLE_CLIENT_ID = 'g-client'
    process.env.GOOGLE_CLIENT_SECRET = 'g-secret'

    expect(loginProvidersConfig()).toEqual({ enabled: true, displayName: 'SSO', google: true })
  })
})
