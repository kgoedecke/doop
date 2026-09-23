import { afterEach, expect, it, vi } from 'vitest'
import { claudeMcpOrigin, claudeRuntimeOrigin } from '../server/remoteClaudeOrigins.ts'

afterEach(() => vi.unstubAllEnvs())

it.each([undefined, 'development'])('allows the local container setup with NODE_ENV=%s', (environment) => {
  vi.stubEnv('NODE_ENV', environment)
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const runtime = `http://${host}:8787`
    vi.stubEnv('CLAUDE_REMOTE_URL', runtime)
    expect(claudeRuntimeOrigin(runtime).origin).toBe(runtime)
    expect(claudeMcpOrigin('http://host.docker.internal:4400').origin).toBe('http://host.docker.internal:4400')
  }
})

it.each(['production', 'staging', 'test'])('rejects HTTP outside development: %s', (environment) => {
  vi.stubEnv('NODE_ENV', environment)
  vi.stubEnv('CLAUDE_REMOTE_URL', 'http://localhost:8787')
  expect(() => claudeRuntimeOrigin('http://localhost:8787')).toThrow('HTTPS origin')
  expect(() => claudeMcpOrigin('http://host.docker.internal:4400')).toThrow('HTTPS origin')
  expect(claudeRuntimeOrigin('https://claude.example').origin).toBe('https://claude.example')
  expect(claudeMcpOrigin('https://tools.example').origin).toBe('https://tools.example')
})

it.each([
  'http://example.com:8787',
  'http://localhost.example:8787',
  'http://host.docker.internal:8787',
  'http://192.168.1.2:8787',
  'ftp://localhost:8787',
  'http://user:pass@localhost:8787',
  'http://localhost:8787/path',
  'http://localhost:8787?token=x',
  'http://localhost:8787#fragment',
])('rejects unsafe runtime origin %s', (value) => {
  vi.stubEnv('NODE_ENV', 'development')
  expect(() => claudeRuntimeOrigin(value)).toThrow()
})

it.each([
  'http://localhost:4400',
  'http://127.0.0.1:4400',
  'http://example.com',
  'http://host.docker.internal.example:4400',
  'http://user:pass@host.docker.internal:4400',
  'http://host.docker.internal:4400/path',
  'http://host.docker.internal:4400?q=x',
  'http://host.docker.internal:4400#fragment',
  'ftp://host.docker.internal:4400',
])('rejects invalid container MCP origin %s', (value) => {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('CLAUDE_REMOTE_URL', 'http://localhost:8787')
  expect(() => claudeMcpOrigin(value)).toThrow()
})

it.each([undefined, 'https://claude.example', 'http://example.com', 'invalid', 'http://localhost/path'])(
  'requires HTTPS MCP for nonlocal runtime %s',
  (runtime) => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('CLAUDE_REMOTE_URL', runtime)
    expect(() => claudeMcpOrigin('http://host.docker.internal:4400')).toThrow()
    expect(claudeMcpOrigin('https://tools.example').origin).toBe('https://tools.example')
  },
)
