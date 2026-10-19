import { stubEnv, unstubAllEnvs } from './envStub.ts'
import { afterEach, expect, it } from 'vitest'
import { claudeMcpOrigin } from '../server/remoteClaudeOrigins.ts'

afterEach(() => unstubAllEnvs())

it.each([undefined, 'development'])('allows the local container setup with NODE_ENV=%s', (environment) => {
  stubEnv('BETTER_AUTH_SECRET', 'test-secret')
  stubEnv('BETTER_AUTH_URL', 'https://doop.example')
  stubEnv('NODE_ENV', environment)
  expect(claudeMcpOrigin('http://host.docker.internal:4400').origin).toBe('http://host.docker.internal:4400')
})

it.each(['production', 'test'])('rejects HTTP outside development: %s', (environment) => {
  stubEnv('BETTER_AUTH_SECRET', 'test-secret')
  stubEnv('BETTER_AUTH_URL', 'https://doop.example')
  stubEnv('NODE_ENV', environment)
  expect(() => claudeMcpOrigin('http://host.docker.internal:4400')).toThrow('HTTPS origin')
  expect(claudeMcpOrigin('https://tools.example').origin).toBe('https://tools.example')
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
  'https://user:pass@tools.example',
  'https://tools.example/path',
  'https://tools.example?q=x',
  'https://tools.example#fragment',
])('rejects invalid container MCP origin %s', (value) => {
  stubEnv('NODE_ENV', 'development')
  expect(() => claudeMcpOrigin(value)).toThrow()
})

it.each([undefined, 'https://claude.example', 'http://example.com', 'invalid', 'http://localhost/path'])(
  'validates MCP callbacks independently of SDK endpoint configuration: %s',
  (runtime) => {
    stubEnv('NODE_ENV', 'development')
    stubEnv('CANTELOP_EDGE_URL', runtime)
    expect(claudeMcpOrigin('http://host.docker.internal:4400').origin).toBe('http://host.docker.internal:4400')
    expect(claudeMcpOrigin('https://tools.example').origin).toBe('https://tools.example')
  },
)
