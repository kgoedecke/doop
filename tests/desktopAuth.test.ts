import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  PENDING_TTL_MS,
  desktopAuthDeepLink,
  desktopHandoffURL,
  desktopSignInURL,
  forgetPendingSignIn,
  isPendingSignIn,
  newChallenge,
  parseDesktopAuthDeepLink,
  parseDesktopHandoffQuery,
  parseDesktopSignInQuery,
  rememberPendingSignIn,
} from '../src/lib/desktopAuth'

const CHALLENGE = '0123456789abcdef0123456789abcdef'

describe('desktop sign-in deep links', () => {
  it('round-trips token, challenge and target', () => {
    const link = desktopAuthDeepLink('abc 123', CHALLENGE, '/c/xyz?x=1')
    expect(parseDesktopAuthDeepLink(link)).toEqual({ token: 'abc 123', challenge: CHALLENGE, to: '/c/xyz?x=1' })
  })

  it('falls back to home for a missing or foreign target', () => {
    expect(parseDesktopAuthDeepLink(`doop://auth?token=t&challenge=${CHALLENGE}`)?.to).toBe('/')
    expect(parseDesktopAuthDeepLink(desktopAuthDeepLink('t', CHALLENGE, '//evil.com'))?.to).toBe('/')
    expect(parseDesktopAuthDeepLink(desktopAuthDeepLink('t', CHALLENGE, 'https://evil.com'))?.to).toBe('/')
  })

  it('rejects other schemes, hosts, malformed URLs and missing parts', () => {
    expect(parseDesktopAuthDeepLink(`https://auth?token=t&challenge=${CHALLENGE}`)).toBeNull()
    expect(parseDesktopAuthDeepLink(`doop://open?token=t&challenge=${CHALLENGE}`)).toBeNull()
    expect(parseDesktopAuthDeepLink(`doop://auth?challenge=${CHALLENGE}`)).toBeNull()
    expect(parseDesktopAuthDeepLink('doop://auth?token=t')).toBeNull()
    expect(parseDesktopAuthDeepLink('not a url')).toBeNull()
  })

  it('builds a handoff callback that carries challenge and target', () => {
    const url = desktopHandoffURL(CHALLENGE, '/c/abc')
    expect(url.startsWith('/desktop/handoff?')).toBe(true)
    expect(parseDesktopHandoffQuery(url.slice(url.indexOf('?')))).toEqual({ challenge: CHALLENGE, to: '/c/abc' })
    expect(parseDesktopHandoffQuery('?to=/c/abc')).toBeNull()
  })
})

describe('desktop sign-in start page', () => {
  it('round-trips provider, challenge and target through the browser URL', () => {
    const request = { provider: 'microsoft' as const, challenge: CHALLENGE, to: '/c/abc' }
    const url = new URL(desktopSignInURL('https://doop.design', request))
    expect(url.origin + url.pathname).toBe('https://doop.design/desktop/signin')
    expect(parseDesktopSignInQuery(url.search)).toEqual(request)
  })

  it('rejects unknown providers and bad challenges, sanitises the target', () => {
    expect(parseDesktopSignInQuery(`?provider=github&challenge=${CHALLENGE}&to=/`)).toBeNull()
    expect(parseDesktopSignInQuery('?provider=google&to=/')).toBeNull()
    expect(parseDesktopSignInQuery('?provider=google&challenge=short&to=/')).toBeNull()
    expect(parseDesktopSignInQuery(`?provider=google&challenge=${CHALLENGE}&to=//evil.com`)?.to).toBe('/')
  })

  it('mints distinct well-formed challenges', () => {
    const a = newChallenge()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(newChallenge()).not.toBe(a)
  })
})

describe('pending sign-in', () => {
  /* node has no localStorage; the record only needs get/set/remove */
  const shim = new Map<string, string>()
  beforeAll(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => shim.get(k) ?? null,
        setItem: (k: string, v: string) => void shim.set(k, v),
        removeItem: (k: string) => void shim.delete(k),
      },
    })
  })
  afterAll(() => {
    Reflect.deleteProperty(globalThis, 'localStorage')
  })
  afterEach(() => forgetPendingSignIn())

  it('recognises only the remembered challenge, until forgotten', () => {
    expect(isPendingSignIn(CHALLENGE)).toBe(false)
    expect(rememberPendingSignIn(CHALLENGE)).toBe(true)
    expect(isPendingSignIn(CHALLENGE)).toBe(true)
    expect(isPendingSignIn(newChallenge())).toBe(false)
    forgetPendingSignIn()
    expect(isPendingSignIn(CHALLENGE)).toBe(false)
  })

  it('reports blocked storage so the browser is never sent off', () => {
    const setItem = localStorage.setItem
    localStorage.setItem = () => {
      throw new Error('quota')
    }
    try {
      expect(rememberPendingSignIn(CHALLENGE)).toBe(false)
    } finally {
      localStorage.setItem = setItem
    }
  })

  it('expires', () => {
    const t0 = 1_000_000
    rememberPendingSignIn(CHALLENGE, t0)
    expect(isPendingSignIn(CHALLENGE, t0 + PENDING_TTL_MS)).toBe(true)
    expect(isPendingSignIn(CHALLENGE, t0 + PENDING_TTL_MS + 1)).toBe(false)
  })
})
