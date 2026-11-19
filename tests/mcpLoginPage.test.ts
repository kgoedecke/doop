import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import { SIGN_IN_PATH } from '../shared/signInPath.ts'

/* A signed-out MCP authorize request must land on a path the SPA owns:
   on the hosted instance `/` is the marketing landing page, which has no
   sign-in form, so a client sent there left people guessing. */

let server: Server

beforeAll(async () => {
  server = await startServer()
}, 70_000)

afterAll(() => server?.stop())

describe('MCP sign-in redirect', () => {
  it('sends a signed-out authorize request to the sign-in page with the request intact', async () => {
    const query = 'client_id=abc&response_type=code&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&state=s1'
    const res = await new Client(server).get(`/api/auth/mcp/authorize?${query}`)
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '', server.base)
    expect(location.pathname).toBe(SIGN_IN_PATH)
    expect(location.searchParams.get('client_id')).toBe('abc')
    expect(location.searchParams.get('response_type')).toBe('code')
    expect(location.searchParams.get('state')).toBe('s1')
  })
})
