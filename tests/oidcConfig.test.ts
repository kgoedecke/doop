import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stubEnv, unstubAllEnvs } from './envStub.ts'
import {
  loadAppleConfig,
  loadGoogleConfig,
  loadMicrosoftConfig,
  loadOidcConfig,
  loginProvidersConfig,
  oidcPublicConfig,
} from '../server/auth.ts'

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
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'MICROSOFT_TENANT_ID',
  'APPLE_CLIENT_ID',
  'APPLE_CLIENT_SECRET',
  'APPLE_APP_BUNDLE_IDENTIFIER',
] as const

/* whatever this shell exports for the providers must not leak into the cases */
beforeEach(() => {
  for (const key of OIDC_VARS) stubEnv(key, undefined)
})

afterEach(unstubAllEnvs)

function setRequiredOidcEnv(): void {
  stubEnv('OIDC_ISSUER', 'https://idp.example.com')
  stubEnv('OIDC_CLIENT_ID', 'client-abc')
  stubEnv('OIDC_CLIENT_SECRET', 'secret-xyz')
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
    for (const [key, value] of Object.entries(partial)) stubEnv(key, value)
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
    stubEnv('OIDC_SCOPES', 'openid,email,groups')

    expect(loadOidcConfig()?.scopes).toEqual(['openid', 'email', 'groups'])
  })

  it('parses space-separated OIDC_SCOPES', () => {
    setRequiredOidcEnv()
    stubEnv('OIDC_SCOPES', 'openid email groups')

    expect(loadOidcConfig()?.scopes).toEqual(['openid', 'email', 'groups'])
  })

  it('uses OIDC_PROVIDER_NAME as the provider name when set', () => {
    setRequiredOidcEnv()
    stubEnv('OIDC_PROVIDER_NAME', 'Zitadel')

    expect(loadOidcConfig()?.providerName).toBe('Zitadel')
  })
})

describe('oidcPublicConfig', () => {
  it('reports disabled with no other fields when unset', () => {
    expect(oidcPublicConfig()).toEqual({ enabled: false })
  })

  it('reports enabled with the display name when configured', () => {
    setRequiredOidcEnv()
    stubEnv('OIDC_PROVIDER_NAME', 'Zitadel')

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
      for (const [key, value] of Object.entries(partial)) stubEnv(key, value)
      expect(() => loadGoogleConfig()).toThrow(/GOOGLE_CLIENT_ID.*GOOGLE_CLIENT_SECRET/)
    },
  )

  it('returns the pair when both are set', () => {
    stubEnv('GOOGLE_CLIENT_ID', 'g-client')
    stubEnv('GOOGLE_CLIENT_SECRET', 'g-secret')

    expect(loadGoogleConfig()).toEqual({ clientId: 'g-client', clientSecret: 'g-secret' })
  })
})

describe('loginProvidersConfig', () => {
  it('reports both providers off when nothing is configured', () => {
    expect(loginProvidersConfig()).toEqual({
      enabled: false,
      google: false,
      microsoft: false,
      apple: false,
      appleNative: false,
    })
  })

  it('reports google on, independently of SSO, and never the secret', () => {
    stubEnv('GOOGLE_CLIENT_ID', 'g-client')
    stubEnv('GOOGLE_CLIENT_SECRET', 'g-secret')

    expect(loginProvidersConfig()).toEqual({
      enabled: false,
      google: true,
      microsoft: false,
      apple: false,
      appleNative: false,
    })
    expect(JSON.stringify(loginProvidersConfig())).not.toContain('g-secret')
  })

  it('combines SSO and google', () => {
    setRequiredOidcEnv()
    stubEnv('GOOGLE_CLIENT_ID', 'g-client')
    stubEnv('GOOGLE_CLIENT_SECRET', 'g-secret')

    expect(loginProvidersConfig()).toEqual({
      enabled: true,
      displayName: 'SSO',
      google: true,
      microsoft: false,
      apple: false,
      appleNative: false,
    })
  })
})

describe('loadMicrosoftConfig', () => {
  it('returns null when neither var is set', () => {
    expect(loadMicrosoftConfig()).toBeNull()
  })

  it.each([{ MICROSOFT_CLIENT_ID: 'm-client' }, { MICROSOFT_CLIENT_SECRET: 'm-secret' }])(
    'throws when only one of the pair is set: %o',
    (partial) => {
      for (const [key, value] of Object.entries(partial)) stubEnv(key, value)
      expect(() => loadMicrosoftConfig()).toThrow(/MICROSOFT_CLIENT_ID.*MICROSOFT_CLIENT_SECRET/)
    },
  )

  it('defaults the tenant to common', () => {
    stubEnv('MICROSOFT_CLIENT_ID', 'm-client')
    stubEnv('MICROSOFT_CLIENT_SECRET', 'm-secret')

    expect(loadMicrosoftConfig()).toEqual({ clientId: 'm-client', clientSecret: 'm-secret', tenantId: 'common' })
  })

  it('takes MICROSOFT_TENANT_ID when set', () => {
    stubEnv('MICROSOFT_CLIENT_ID', 'm-client')
    stubEnv('MICROSOFT_CLIENT_SECRET', 'm-secret')
    stubEnv('MICROSOFT_TENANT_ID', 'tenant-123')

    expect(loadMicrosoftConfig()?.tenantId).toBe('tenant-123')
  })

  it('shows up in loginProvidersConfig without the secret', () => {
    stubEnv('MICROSOFT_CLIENT_ID', 'm-client')
    stubEnv('MICROSOFT_CLIENT_SECRET', 'm-secret')

    expect(loginProvidersConfig()).toEqual({
      enabled: false,
      google: false,
      microsoft: true,
      apple: false,
      appleNative: false,
    })
    expect(JSON.stringify(loginProvidersConfig())).not.toContain('m-secret')
  })
})

describe('loadAppleConfig', () => {
  it('returns null when nothing is set', () => {
    expect(loadAppleConfig()).toBeNull()
  })

  it.each([{ APPLE_CLIENT_ID: 'a-client' }, { APPLE_CLIENT_SECRET: 'a-secret' }])(
    'throws when only one of the web pair is set: %o',
    (partial) => {
      for (const [key, value] of Object.entries(partial)) stubEnv(key, value)
      expect(() => loadAppleConfig()).toThrow(/APPLE_CLIENT_ID.*APPLE_CLIENT_SECRET/)
    },
  )

  it('enables the native half on its own', () => {
    stubEnv('APPLE_APP_BUNDLE_IDENTIFIER', 'design.doop.ios')

    expect(loadAppleConfig()).toEqual({ web: null, appBundleIdentifier: 'design.doop.ios' })
    expect(loginProvidersConfig()).toEqual({
      enabled: false,
      google: false,
      microsoft: false,
      apple: false,
      appleNative: true,
    })
  })

  it('enables the web half on its own, never leaking the secret', () => {
    stubEnv('APPLE_CLIENT_ID', 'design.doop.web')
    stubEnv('APPLE_CLIENT_SECRET', 'a-secret')

    expect(loadAppleConfig()).toEqual({
      web: { clientId: 'design.doop.web', clientSecret: 'a-secret' },
      appBundleIdentifier: null,
    })
    expect(loginProvidersConfig()).toEqual({
      enabled: false,
      google: false,
      microsoft: false,
      apple: true,
      appleNative: false,
    })
    expect(JSON.stringify(loginProvidersConfig())).not.toContain('a-secret')
  })

  it('combines both halves', () => {
    stubEnv('APPLE_CLIENT_ID', 'design.doop.web')
    stubEnv('APPLE_CLIENT_SECRET', 'a-secret')
    stubEnv('APPLE_APP_BUNDLE_IDENTIFIER', 'design.doop.ios')

    expect(loginProvidersConfig()).toMatchObject({ apple: true, appleNative: true })
  })
})
