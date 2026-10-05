import { afterEach, describe, expect, it, vi } from 'vitest'
import { getIssue, linearQuery, listIssues } from '../server/linear/client.ts'
import { z } from 'zod'

afterEach(() => vi.unstubAllGlobals())

function respond(body: unknown, status = 200) {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

describe('Linear client', () => {
  it('passes bounded, server-side filters and pagination with personal-key authentication', async () => {
    const fetcher = respond({ data: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'next' } } } })
    const result = await listIssues('secret', { team_key: 'ENG', assignee_id: 'user-1', first: 10, after: 'previous' })
    expect(result.issues.pageInfo.endCursor).toBe('next')
    const init = fetcher.mock.calls[0]![1] as RequestInit
    expect(init.headers).toMatchObject({ Authorization: 'secret' })
    expect(JSON.parse(String(init.body)).variables).toEqual({
      first: 10,
      after: 'previous',
      filter: {
        team: { key: { eq: 'ENG' } },
        assignee: { id: { eq: 'user-1' } },
        state: { type: { nin: ['completed', 'canceled'] } },
      },
    })
  })

  it('rejects unbounded lists before making a request', () => {
    const fetcher = respond({})
    expect(() => listIssues('secret', { first: 100 })).toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('uses variables to read ticket identifiers', async () => {
    const fetcher = respond({ data: { issue: null } })
    expect(await getIssue('secret', 'ENG-123')).toEqual({ issue: null })
    expect(JSON.parse(String(fetcher.mock.calls[0]![1].body)).variables).toEqual({ id: 'ENG-123' })
  })

  it.each([
    [401, {}, /Reconnect/],
    [200, { errors: [{ message: 'secret', extensions: { code: 'AUTHENTICATION_ERROR' } }] }, /Reconnect/],
    [429, {}, /rate limit/],
    [200, { errors: [{ message: 'secret', extensions: { code: 'RATELIMITED' } }] }, /rate limit/],
    [200, { data: { ok: true }, errors: [{ message: 'secret' }] }, /could not complete/],
    [200, { data: {} }, /unexpected response/],
  ])('handles HTTP/GraphQL failures without exposing upstream messages (%s)', async (status, body, message) => {
    respond(body, status)
    await expect(linearQuery('secret', 'query Test { ok }', {}, z.object({ ok: z.boolean() }))).rejects.toThrow(message)
  })

  it('sanitizes network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('secret')))
    await expect(getIssue('secret', 'ENG-123')).rejects.toThrow('Could not reach Linear')
  })
})
