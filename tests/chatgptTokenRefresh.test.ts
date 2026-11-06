import { afterEach, expect, it, vi } from 'vitest'

/* the refreshed tokens are written back; the row itself is not under test */
const writes = vi.hoisted(() => [] as unknown[])
vi.mock('../server/db/index.ts', () => ({
  db: {
    update: () => ({
      set: (values: unknown) => {
        writes.push(values)
        return { where: () => Promise.resolve() }
      },
    }),
  },
}))
import { withFreshToken, type ModelAccount } from '../server/modelAccounts.ts'

afterEach(() => {
  vi.restoreAllMocks()
  writes.length = 0
})

const expired = (model: string, effort: ModelAccount['effort']): ModelAccount => ({
  userId: 'alice',
  kind: 'chatgpt',
  accessToken: 'old',
  refreshToken: 'refresh-1',
  expiresAt: 0,
  model,
  effort,
  enabled: true,
  connectedAt: 1,
})

/* Two tasks on different canvases, each with its own pick, both finding the
   token expired: one refresh is spent, and each keeps the model and effort it
   was sent with rather than the first caller's. */
it('shares one refresh between racing tasks without swapping their picks', async () => {
  let release: (res: Response) => void = () => {}
  const fetch = vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>((resolve) => (release = resolve)))
  const first = withFreshToken(expired('gpt-5.6-terra', 'high'))
  const second = withFreshToken(expired('gpt-5.6-luna', 'low'))
  release(
    new Response(JSON.stringify({ access_token: 'fresh', refresh_token: 'refresh-2', expires_in: 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  const [a, b] = await Promise.all([first, second])
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(writes).toHaveLength(1)
  expect(a).toMatchObject({ accessToken: 'fresh', refreshToken: 'refresh-2', model: 'gpt-5.6-terra', effort: 'high' })
  expect(b).toMatchObject({ accessToken: 'fresh', refreshToken: 'refresh-2', model: 'gpt-5.6-luna', effort: 'low' })
})
