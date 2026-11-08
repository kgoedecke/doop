import { getIp } from 'better-auth/api'
import { getIPFromHeader } from '@better-auth/core/utils/ip'
import { afterEach, describe, expect, it } from 'vitest'
import { loadIpAddressConfig } from '../server/auth.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

afterEach(unstubAllEnvs)

describe('loadIpAddressConfig', () => {
  it('returns null when neither AUTH_IP_HEADERS nor AUTH_TRUSTED_PROXIES is configured', () => {
    stubEnv('AUTH_IP_HEADERS', undefined)
    stubEnv('AUTH_TRUSTED_PROXIES', undefined)
    expect(loadIpAddressConfig()).toBeNull()
  })

  it('returns null when variables contain only empty strings or whitespace', () => {
    stubEnv('AUTH_IP_HEADERS', '   ')
    stubEnv('AUTH_TRUSTED_PROXIES', '')
    expect(loadIpAddressConfig()).toBeNull()
  })

  it('normalizes header names to lowercase and trims whitespace', () => {
    stubEnv('AUTH_IP_HEADERS', ' Fly-Client-IP, CF-Connecting-IP ')
    expect(loadIpAddressConfig()).toEqual({
      ipAddressHeaders: ['fly-client-ip', 'cf-connecting-ip'],
    })
  })

  it('supports single header configuration', () => {
    stubEnv('AUTH_IP_HEADERS', 'fly-client-ip')
    expect(loadIpAddressConfig()).toEqual({
      ipAddressHeaders: ['fly-client-ip'],
    })
  })

  it('supports comma-separated trusted proxy CIDRs', () => {
    stubEnv('AUTH_TRUSTED_PROXIES', '10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16')
    expect(loadIpAddressConfig()).toEqual({
      trustedProxies: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
    })
  })

  it('combines both headers and trusted proxies when both are set', () => {
    stubEnv('AUTH_IP_HEADERS', 'fly-client-ip, x-forwarded-for')
    stubEnv('AUTH_TRUSTED_PROXIES', '10.0.0.0/8')
    expect(loadIpAddressConfig()).toEqual({
      ipAddressHeaders: ['fly-client-ip', 'x-forwarded-for'],
      trustedProxies: ['10.0.0.0/8'],
    })
  })
})

describe('Better Auth client IP resolution with loaded configuration', () => {
  const FLY_CLIENT = '203.0.113.195'
  const PROXY_HOP = '10.0.0.1'
  const CF_CLIENT = '198.51.100.42'
  const LOCALHOST = '127.0.0.1'

  it('reproduces issue #425: multi-hop X-Forwarded-For cannot be resolved by getIPFromHeader', () => {
    // Under default Better Auth options, only x-forwarded-for is inspected.
    // Without trusted proxies configured, getIPFromHeader fails closed (returns null) on multi-hop chains,
    // which in production causes Better Auth's rate limiter to lump all users into "no-trusted-ip".
    const multiHopXff = `${FLY_CLIENT}, ${PROXY_HOP}`
    expect(getIPFromHeader(multiHopXff, {})).toBeNull()

    // In a test environment, getIp falls back to 127.0.0.1 when header extraction fails
    const req = new Request('http://localhost:3000/api/auth/sign-in', {
      headers: {
        'x-forwarded-for': multiHopXff,
        'fly-client-ip': FLY_CLIENT,
      },
    })
    expect(getIp(req, {})).toBe(LOCALHOST)
  })

  it('resolves genuine client IP using Fly-Client-IP header on Fly.io', () => {
    stubEnv('AUTH_IP_HEADERS', 'fly-client-ip')
    const config = loadIpAddressConfig()
    expect(config).not.toBeNull()

    const req = new Request('http://localhost:3000/api/auth/sign-in', {
      headers: {
        'x-forwarded-for': `${FLY_CLIENT}, ${PROXY_HOP}`,
        'fly-client-ip': FLY_CLIENT,
      },
    })
    const resolved = getIp(req, { advanced: { ipAddress: config! } })
    expect(resolved).toBe(FLY_CLIENT)
    expect(resolved).not.toBe(LOCALHOST)
  })

  it('resolves genuine client IP using CF-Connecting-IP on Cloudflare', () => {
    stubEnv('AUTH_IP_HEADERS', 'cf-connecting-ip')
    const config = loadIpAddressConfig()
    expect(config).not.toBeNull()

    const req = new Request('http://localhost:3000/api/auth/sign-in', {
      headers: {
        'x-forwarded-for': `${CF_CLIENT}, 172.70.100.1`,
        'cf-connecting-ip': CF_CLIENT,
      },
    })
    const resolved = getIp(req, { advanced: { ipAddress: config! } })
    expect(resolved).toBe(CF_CLIENT)
    expect(resolved).not.toBe(LOCALHOST)
  })

  it('falls back through header priority list', () => {
    stubEnv('AUTH_IP_HEADERS', 'cf-connecting-ip, fly-client-ip, x-forwarded-for')
    const config = loadIpAddressConfig()
    expect(config).not.toBeNull()

    // 1. CF header present: takes cf-connecting-ip
    const reqCf = new Request('http://localhost:3000/api/auth/sign-in', {
      headers: {
        'cf-connecting-ip': CF_CLIENT,
        'fly-client-ip': FLY_CLIENT,
      },
    })
    expect(getIp(reqCf, { advanced: { ipAddress: config! } })).toBe(CF_CLIENT)

    // 2. CF absent, Fly present: falls back to fly-client-ip
    const reqFly = new Request('http://localhost:3000/api/auth/sign-in', {
      headers: {
        'fly-client-ip': FLY_CLIENT,
      },
    })
    expect(getIp(reqFly, { advanced: { ipAddress: config! } })).toBe(FLY_CLIENT)

    // 3. Both proxy headers absent: falls back to single-hop x-forwarded-for
    const reqXff = new Request('http://localhost:3000/api/auth/sign-in', {
      headers: {
        'x-forwarded-for': '192.0.2.1',
      },
    })
    expect(getIp(reqXff, { advanced: { ipAddress: config! } })).toBe('192.0.2.1')
  })

  it('resolves multi-hop X-Forwarded-For when AUTH_TRUSTED_PROXIES is configured', () => {
    stubEnv('AUTH_TRUSTED_PROXIES', '10.0.0.0/8')
    const config = loadIpAddressConfig()
    expect(config).not.toBeNull()

    const req = new Request('http://localhost:3000/api/auth/sign-in', {
      headers: {
        'x-forwarded-for': `${FLY_CLIENT}, 10.1.2.3`,
      },
    })
    const resolved = getIp(req, { advanced: { ipAddress: config! } })
    expect(resolved).toBe(FLY_CLIENT)
  })

  it('prevents IP spoofing via malicious X-Forwarded-For injection', () => {
    const SPOOFED_IP = '1.1.1.1'

    // Scenario A: Edge proxy header (fly-client-ip) ignores forged X-Forwarded-For
    stubEnv('AUTH_IP_HEADERS', 'fly-client-ip')
    const flyConfig = loadIpAddressConfig()
    const reqFly = new Request('http://localhost:3000/api/auth/sign-in', {
      headers: {
        'x-forwarded-for': `${SPOOFED_IP}, ${FLY_CLIENT}, ${PROXY_HOP}`,
        'fly-client-ip': FLY_CLIENT,
      },
    })
    expect(getIp(reqFly, { advanced: { ipAddress: flyConfig! } })).toBe(FLY_CLIENT)

    // Scenario B: Trusted proxies safely walks right-to-left and ignores forged leftmost token
    stubEnv('AUTH_IP_HEADERS', undefined)
    stubEnv('AUTH_TRUSTED_PROXIES', '10.0.0.0/8')
    const proxyConfig = loadIpAddressConfig()
    const reqProxy = new Request('http://localhost:3000/api/auth/sign-in', {
      headers: {
        'x-forwarded-for': `${SPOOFED_IP}, ${FLY_CLIENT}, 10.0.0.1`,
      },
    })
    expect(getIp(reqProxy, { advanced: { ipAddress: proxyConfig! } })).toBe(FLY_CLIENT)
  })

  it('normalizes and groups IPv6 addresses by /64 subnet', () => {
    stubEnv('AUTH_IP_HEADERS', 'fly-client-ip')
    const config = loadIpAddressConfig()
    const reqIPv6 = new Request('http://localhost:3000/api/auth/sign-in', {
      headers: {
        'fly-client-ip': '2001:db8:85a3:8d3:1319:8a2e:370:7348',
      },
    })
    const resolved = getIp(reqIPv6, { advanced: { ipAddress: config! } })
    expect(resolved).toBe('2001:0db8:85a3:08d3:0000:0000:0000:0000')
  })

  it('handles missing or empty headers gracefully', () => {
    stubEnv('AUTH_IP_HEADERS', 'fly-client-ip')
    const config = loadIpAddressConfig()

    expect(getIPFromHeader('', {})).toBeNull()
    expect(getIPFromHeader('   ', {})).toBeNull()

    const reqEmpty = new Request('http://localhost:3000/api/auth/sign-in', {
      headers: {},
    })
    // In test environment, unresolvable headers fall back to LOCALHOST
    expect(getIp(reqEmpty, { advanced: { ipAddress: config! } })).toBe(LOCALHOST)

    const reqBlank = new Request('http://localhost:3000/api/auth/sign-in', {
      headers: {
        'fly-client-ip': '   ',
      },
    })
    expect(getIp(reqBlank, { advanced: { ipAddress: config! } })).toBe(LOCALHOST)
  })

  it('ensures distinct clients receive distinct rate-limit keys', () => {
    stubEnv('AUTH_IP_HEADERS', 'fly-client-ip')
    const config = loadIpAddressConfig()

    const clientA = new Request('http://localhost:3000/api/auth/sign-in', {
      headers: { 'fly-client-ip': '203.0.113.10' },
    })
    const clientB = new Request('http://localhost:3000/api/auth/sign-in', {
      headers: { 'fly-client-ip': '203.0.113.20' },
    })

    const ipA = getIp(clientA, { advanced: { ipAddress: config! } })
    const ipB = getIp(clientB, { advanced: { ipAddress: config! } })

    expect(ipA).toBe('203.0.113.10')
    expect(ipB).toBe('203.0.113.20')
    expect(ipA).not.toBe(ipB)
  })
})
