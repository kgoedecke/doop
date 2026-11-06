import { describe, expect, it } from 'vitest'
import { FIRST_CANVAS_PATH, firstCanvasPathAfterSignup, signupLanding } from '../shared/firstCanvas.ts'

describe('signupLanding', () => {
  it('keeps a signup that started on a shared canvas link on that canvas', () => {
    expect(signupLanding('/c/abc', '')).toBe('/c/abc')
    expect(signupLanding('/c/abc', '?frame=f1&element=e1')).toBe('/c/abc?frame=f1&element=e1')
    expect(signupLanding('/c/abc/proto', '')).toBe('/c/abc/proto')
    expect(signupLanding('/w/team', '')).toBe('/w/team')
  })

  it('tags a provider signup on a shared link with its method', () => {
    expect(signupLanding('/c/abc', '', 'google')).toBe('/c/abc?signup=google')
    expect(signupLanding('/c/abc', '?frame=f1', 'oidc')).toBe('/c/abc?frame=f1&signup=oidc')
  })

  it('sends every other signup to its first canvas', () => {
    expect(signupLanding('/', '')).toBe(FIRST_CANVAS_PATH)
    expect(signupLanding('/auth', '')).toBe(FIRST_CANVAS_PATH)
    expect(signupLanding('/c/', '')).toBe(FIRST_CANVAS_PATH)
    expect(signupLanding('/settings', '', 'apple')).toBe(firstCanvasPathAfterSignup('apple'))
  })
})
