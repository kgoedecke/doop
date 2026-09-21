import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { signup, signin } = vi.hoisted(() => ({ signup: vi.fn(), signin: vi.fn() }))
vi.mock('../src/lib/auth', () => ({
  authClient: { signUp: { email: signup }, signIn: { email: signin } },
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  })
  vi.stubEnv('DEV', true)
  vi.stubEnv('VITE_DEV_AUTO_LOGIN', '')
  vi.stubGlobal('location', { hostname: 'localhost' })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ exists: false }) }))
  signup.mockResolvedValue({ error: null })
  signin.mockResolvedValue({ error: null })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('creates one test account even with concurrent effect calls', async () => {
  const { devLogin } = await import('../src/lib/devLogin')
  await Promise.all([devLogin(), devLogin()])
  expect(signup).toHaveBeenCalledTimes(1)
  expect(signup).toHaveBeenCalledWith(expect.objectContaining({ name: 'Local Tester' }))
  expect(signin).not.toHaveBeenCalled()
})

it('reuses saved credentials after a reload', async () => {
  const credentials = { email: 'local-test@example.test', password: 'test-password' }
  localStorage.setItem('doop-local-test-account', JSON.stringify(credentials))
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ exists: true }) } as Response)
  await (await import('../src/lib/devLogin')).devLogin()
  expect(signin).toHaveBeenCalledWith(credentials)
  expect(signup).not.toHaveBeenCalled()
})

it.each(['production', 'remote', 'disabled'])('does nothing when %s', async (mode) => {
  if (mode === 'production') vi.stubEnv('DEV', false)
  if (mode === 'remote') vi.stubGlobal('location', { hostname: 'doop.design' })
  if (mode === 'disabled') vi.stubEnv('VITE_DEV_AUTO_LOGIN', 'false')
  const { devLoginEnabled, devLogin } = await import('../src/lib/devLogin')
  expect(devLoginEnabled).toBe(false)
  await devLogin()
  expect(fetch).not.toHaveBeenCalled()
  expect(signup).not.toHaveBeenCalled()
  expect(signin).not.toHaveBeenCalled()
})
