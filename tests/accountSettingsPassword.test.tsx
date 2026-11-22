// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({
  useSession: vi.fn(),
  listAccounts: vi.fn(),
  changePassword: vi.fn(),
}))
const api = vi.hoisted(() => ({ notificationSettings: vi.fn(), setPassword: vi.fn() }))
vi.mock('../src/lib/auth', () => ({ authClient: auth }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn(), reset: vi.fn() } }))
vi.mock('../src/lib/shell', () => ({ isDesktopShell: () => false }))
vi.mock('../src/lib/api', async (importOriginal) => ({ ...(await importOriginal<object>()), api }))
import { AccountSettings } from '../src/components/AccountSettings'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  auth.useSession.mockReturnValue({
    data: { user: { id: 'u1', name: 'Ana', email: 'ana@test.dev' } },
    refetch: vi.fn(),
  })
  api.notificationSettings.mockResolvedValue({ commentEmails: true, emailConfigured: true })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.resetAllMocks()
})

async function render(providers: string[]) {
  auth.listAccounts.mockResolvedValue({ data: providers.map((providerId) => ({ providerId })), error: null })
  await act(async () => root.render(<AccountSettings />))
}

const field = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)

async function type(label: string, value: string) {
  const input = field(label)!
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!found) throw new Error(`no button "${label}"`)
  return found
}

it('offers a provider-only account a set-password form with no current password', async () => {
  api.setPassword.mockResolvedValue({ ok: true })
  await render(['google'])
  expect(field('Current password')).toBeNull()
  expect(button('Set password').disabled).toBe(true)

  await type('New password', 'a-brand-new-password')
  await type('Confirm password', 'something-else-entirely')
  expect(container.textContent).toContain('The two passwords do not match')
  expect(button('Set password').disabled).toBe(true)

  await type('Confirm password', 'a-brand-new-password')
  await act(async () => button('Set password').click())
  expect(api.setPassword).toHaveBeenCalledWith('a-brand-new-password')
  expect(auth.changePassword).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Password updated')
  expect(field('Current password')).not.toBeNull()
})

it('keeps the change form, with the current password, for an account that has one', async () => {
  await render(['credential', 'google'])
  expect(field('Current password')).not.toBeNull()
  expect(field('Confirm password')).toBeNull()
  expect(document.body.textContent).not.toContain('Set password')
})

it('keeps the change form when the account lookup fails', async () => {
  auth.listAccounts.mockResolvedValue({ data: null, error: { message: 'down' } })
  await act(async () => root.render(<AccountSettings />))
  expect(field('Current password')).not.toBeNull()
})

it("shows the server's reason when setting is refused", async () => {
  const { ApiError } = await import('../src/lib/api')
  api.setPassword.mockRejectedValue(
    new ApiError(403, JSON.stringify({ error: 'sign out and back in, then try again' })),
  )
  await render(['google'])
  await type('New password', 'a-brand-new-password')
  await type('Confirm password', 'a-brand-new-password')
  await act(async () => button('Set password').click())
  expect(container.textContent).toContain('sign out and back in, then try again')
})
