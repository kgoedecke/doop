// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ModelAccountStatus } from '../src/lib/api'

const mocks = vi.hoisted(() => ({ modelAccount: vi.fn() }))
vi.mock('../src/lib/api', () => ({ api: { modelAccount: mocks.modelAccount } }))
vi.mock('../src/lib/auth', () => ({ authClient: { useSession: () => ({ data: null }) } }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/shell', () => ({ isDesktopShell: () => false }))
vi.mock('../src/App', () => ({ navigate: vi.fn() }))

import { useModelAccount } from '../src/components/ModelAccount'

type Hook = ReturnType<typeof useModelAccount>

let root: Root
let hook: Hook
const replies: ((status: ModelAccountStatus) => void)[] = []

function Probe() {
  hook = useModelAccount()
  return null
}

function status(model: string): ModelAccountStatus {
  return { connected: true, model } as unknown as ModelAccountStatus
}

function shownModel(): unknown {
  return (hook.account as unknown as { model?: string } | null)?.model
}

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  replies.length = 0
  mocks.modelAccount.mockImplementation(() => new Promise<ModelAccountStatus>((resolve) => replies.push(resolve)))
  root = createRoot(document.createElement('div'))
  await act(async () => root.render(<Probe />))
})

afterEach(() => {
  act(() => root.unmount())
})

it('keeps a saved model when an older refresh lands after it', async () => {
  await act(async () => hook.set(status('new')))
  await act(async () => replies[0]?.(status('old')))
  expect(shownModel()).toBe('new')
})

it('keeps the newest refresh when replies arrive out of order', async () => {
  await act(async () => hook.refresh())
  await act(async () => replies[1]?.(status('newer')))
  await act(async () => replies[0]?.(status('older')))
  expect(shownModel()).toBe('newer')
})

it('applies a refresh started after the last save', async () => {
  await act(async () => hook.set(status('saved')))
  await act(async () => hook.refresh())
  await act(async () => replies[1]?.(status('fresh')))
  expect(shownModel()).toBe('fresh')
})
