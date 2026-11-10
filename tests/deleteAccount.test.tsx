// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  deleteUser: vi.fn(),
}))
vi.mock('../src/lib/auth', () => ({ authClient: auth }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn(), reset: vi.fn() } }))
vi.mock('../src/lib/shell', () => ({ isDesktopShell: () => false }))
import { DeleteAccountCard } from '../src/components/DeleteAccount'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
let assign: ReturnType<typeof vi.fn>
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  assign = vi.fn()
  vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as unknown as Location)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  auth.listAccounts.mockReset()
  auth.deleteUser.mockReset()
})

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!found) throw new Error(`no button "${label}"`)
  return found
}

async function openDialog(providers: string[]) {
  auth.listAccounts.mockResolvedValue({ data: providers.map((providerId) => ({ providerId })), error: null })
  await act(async () => root.render(<DeleteAccountCard />))
  expect(container.textContent).toContain('cannot be undone')
  await act(async () => button('Delete account…').click())
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('This action cannot be undone.')
}

async function typePassword(value: string) {
  const input = document.querySelector<HTMLInputElement>('#delete-password')!
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('asks a password account for its password before deleting it', async () => {
  auth.deleteUser.mockResolvedValue({ data: { success: true }, error: null })
  await openDialog(['credential'])
  expect(button('Delete account').disabled).toBe(true)
  await typePassword('hunter22')
  await act(async () => button('Delete account').click())
  expect(auth.deleteUser).toHaveBeenCalledWith({ password: 'hunter22' })
  expect(assign).toHaveBeenCalledWith('/')
})

it('deletes a provider-only account without a password', async () => {
  auth.deleteUser.mockResolvedValue({ data: { success: true }, error: null })
  await openDialog(['google'])
  expect(document.querySelector('#delete-password')).toBeNull()
  await act(async () => button('Delete account').click())
  expect(auth.deleteUser).toHaveBeenCalledWith({})
  expect(assign).toHaveBeenCalledWith('/')
})

it('asks a provider-only account with a stale session to sign in again', async () => {
  auth.deleteUser.mockResolvedValue({ data: null, error: { status: 400, message: 'Session expired' } })
  await openDialog(['google'])
  await act(async () => button('Delete account').click())
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('sign in again')
  expect(assign).not.toHaveBeenCalled()
})

it('lets a request that never answered be retried or cancelled', async () => {
  auth.deleteUser.mockRejectedValue(new TypeError('Failed to fetch'))
  await openDialog(['credential'])
  await typePassword('hunter22')
  await act(async () => button('Delete account').click())
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('could not be deleted')
  expect(button('Delete account').disabled).toBe(false)
  expect(button('Cancel').disabled).toBe(false)
  expect(assign).not.toHaveBeenCalled()
})

it('shows a wrong password and stays signed in', async () => {
  auth.deleteUser.mockResolvedValue({ data: null, error: { status: 400, message: 'Invalid password' } })
  await openDialog(['credential'])
  await typePassword('nope')
  await act(async () => button('Delete account').click())
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Invalid password')
  expect(assign).not.toHaveBeenCalled()
})
