// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { linearIntegration } from '../src/integrations/linear'
import type { IntegrationsStatus } from '../src/lib/api'

const mocks = vi.hoisted(() => ({ req: vi.fn() }))
vi.mock('../src/lib/api', async (original) => ({
  ...(await original<typeof import('../src/lib/api')>()),
  req: mocks.req,
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
const disconnect = vi.fn()
const setStatus = vi.fn()
const status = {
  linear: { connected: true, personalConnected: true, accountName: 'Alice' },
} as unknown as IntegrationsStatus
const button = (label: string) =>
  Array.from(container.querySelectorAll('button')).find((entry) => entry.textContent === label)!
const input = () => container.querySelector<HTMLInputElement>('input[type="password"]')!

beforeEach(async () => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const Card = linearIntegration.SettingsCard
  await act(async () =>
    root.render(
      <Card
        status={status}
        busy={false}
        setBusy={vi.fn()}
        setStatus={setStatus}
        requestDisconnect={disconnect}
        showToast={vi.fn()}
      />,
    ),
  )
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function enterKey() {
  await act(async () => button('Replace key').click())
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), 'lin_api_replacement')
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('lets a connected user cancel replacement without changing the connection', async () => {
  await enterKey()
  await act(async () => button('Cancel').click())
  expect(input()).toBeNull()
  expect(mocks.req).not.toHaveBeenCalled()
  expect(disconnect).not.toHaveBeenCalled()
})

it('saves a replacement without disconnecting and clears the key field', async () => {
  mocks.req.mockResolvedValue(status)
  await enterKey()
  await act(async () =>
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  expect(mocks.req).toHaveBeenCalledExactlyOnceWith('/api/integrations/linear/token', {
    method: 'POST',
    body: JSON.stringify({ token: 'lin_api_replacement' }),
  })
  expect(setStatus).toHaveBeenCalledWith(status)
  expect(disconnect).not.toHaveBeenCalled()
  expect(input()).toBeNull()
})

it('keeps the connection and replacement form available after validation fails', async () => {
  mocks.req.mockRejectedValue(new Error('invalid key'))
  await enterKey()
  await act(async () =>
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
  expect(input().value).toBe('lin_api_replacement')
  expect(setStatus).not.toHaveBeenCalled()
  expect(disconnect).not.toHaveBeenCalled()
})
