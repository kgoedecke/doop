import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stubEnv, unstubAllEnvs } from './envStub.ts'
import { analyticsConfig } from '../server/analytics.ts'

/* GET /api/analytics-config hands this to the iOS app, which sends nothing without a key */

beforeEach(() => {
  stubEnv('VITE_POSTHOG_KEY', undefined)
  stubEnv('POSTHOG_KEY', undefined)
})

afterEach(unstubAllEnvs)

describe('analyticsConfig', () => {
  it('has no key when the server has analytics off', () => {
    expect(analyticsConfig()).toEqual({ posthogKey: null })
  })

  it('hands out the browser token, the one the web app sends with', () => {
    stubEnv('VITE_POSTHOG_KEY', 'phc_web')
    stubEnv('POSTHOG_KEY', 'phc_server')
    expect(analyticsConfig()).toEqual({ posthogKey: 'phc_web' })
  })

  it('falls back to the server token', () => {
    stubEnv('POSTHOG_KEY', 'phc_server')
    expect(analyticsConfig()).toEqual({ posthogKey: 'phc_server' })
  })
})
