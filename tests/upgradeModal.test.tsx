// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkspaceSummary } from '../shared/types'

const api = vi.hoisted(() => ({
  billingPlans: vi.fn(),
  listWorkspaces: vi.fn(),
  getWorkspace: vi.fn(),
  createWorkspace: vi.fn(),
  workspaceCheckout: vi.fn(),
}))
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  api,
}))
vi.mock('../src/lib/auth', () => ({
  authClient: { useSession: () => ({ data: { user: { id: 'alice', name: 'Alice Doe', email: 'alice@test.dev' } } }) },
}))
const navigate = vi.hoisted(() => vi.fn())
vi.mock('../src/lib/navigate', () => ({ navigate }))
import { PLANS } from '../shared/billing'
import { UpgradeModal } from '../src/components/WorkspaceModals'
import { takeNameAfterCheckout } from '../src/lib/upgrade'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * "Upgrade to Pro" from anywhere: the modal opened without a workspace
 * names a new one and pays for it, or says the account is already on Pro.
 */

let root: Root
let container: HTMLDivElement
const assign = vi.fn()
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  api.billingPlans.mockResolvedValue({ enabled: true, plans: PLANS, intervals: ['month', 'year'] })
  Object.defineProperty(window, 'location', { value: { ...window.location, assign }, configurable: true })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

function workspace(over: Partial<WorkspaceSummary>): WorkspaceSummary {
  return {
    id: 'ws1',
    name: 'Acme',
    ownerId: 'alice',
    role: 'owner',
    status: 'inactive',
    active: false,
    seatsBought: 1,
    memberCount: 1,
    ...over,
  } as WorkspaceSummary
}

function button(label: string) {
  return [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
}

it('makes a workspace for someone who has none at checkout, to be named once paid', async () => {
  api.listWorkspaces.mockResolvedValue({ workspaces: [], billing: { enabled: true } })
  api.createWorkspace.mockResolvedValue(workspace({ id: 'new', name: 'Alice’s workspace' }))
  /* once made, the new workspace is the one a retried checkout pays for */
  api.getWorkspace.mockResolvedValue({ ...workspace({ id: 'new' }), members: [] })
  api.workspaceCheckout.mockResolvedValue({ url: 'https://checkout.stripe.test/x' })
  await act(async () => root.render(<UpgradeModal onClose={() => {}} />))

  expect(document.body.textContent).toContain('Upgrade to Pro')
  expect(document.body.textContent).toContain('Compare all features')
  expect(document.querySelector('input[aria-label="Workspace name"]')).toBeNull()

  /* seats are picked up front: two more than the one person there is */
  const more = document.querySelector<HTMLButtonElement>('button[aria-label="More seats"]')!
  await act(async () => more.click())
  await act(async () => more.click())
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Seats"]')!.value).toBe('3')
  expect(document.body.textContent).toContain('seats × $20')
  expect(document.body.textContent).toContain('$60 per month')

  await act(async () => button('Continue to checkout')!.click())
  expect(api.createWorkspace).toHaveBeenCalledWith('Alice’s workspace')
  expect(api.workspaceCheckout).toHaveBeenCalledWith('new', 'month', 3)
  expect(assign).toHaveBeenCalledWith('https://checkout.stripe.test/x')
  /* the Workspace page asks for the real name when checkout comes back paid, once */
  expect(takeNameAfterCheckout('new')).toBe(true)
  expect(takeNameAfterCheckout('new')).toBe(false)
})

it('pays for a workspace of theirs that never got a plan instead of making another', async () => {
  api.listWorkspaces.mockResolvedValue({ workspaces: [workspace({})], billing: { enabled: true } })
  api.getWorkspace.mockResolvedValue({ ...workspace({}), members: [] })
  api.workspaceCheckout.mockResolvedValue({ url: 'https://checkout.stripe.test/y' })
  await act(async () => root.render(<UpgradeModal onClose={() => {}} />))

  expect(document.querySelector('input[aria-label="Workspace name"]')).toBeNull()
  await act(async () => button('Continue to checkout')!.click())
  expect(api.createWorkspace).not.toHaveBeenCalled()
  expect(api.workspaceCheckout).toHaveBeenCalledWith('ws1', 'month', 1)
})

it('says who is already on Pro, and sends them to billing', async () => {
  api.listWorkspaces.mockResolvedValue({
    workspaces: [workspace({ status: 'active', active: true, plan: 'team' })],
    billing: { enabled: true },
  })
  await act(async () => root.render(<UpgradeModal onClose={() => {}} />))

  expect(document.body.textContent).toContain('You’re on Pro through Acme.')
  expect(button('Continue to checkout')).toBeUndefined()
  await act(async () => button('Manage billing')!.click())
  expect(navigate).toHaveBeenCalledWith('/w/ws1?pane=billing')
})

it('leaves a canceled workspace alone and makes a new one, since reactivating bills its old team', async () => {
  api.listWorkspaces.mockResolvedValue({
    workspaces: [workspace({ status: 'canceled', active: false, plan: 'team', memberCount: 6 })],
    billing: { enabled: true },
  })
  api.createWorkspace.mockResolvedValue(workspace({ id: 'new' }))
  api.getWorkspace.mockResolvedValue({ ...workspace({ id: 'new' }), members: [] })
  api.workspaceCheckout.mockResolvedValue({ url: 'https://checkout.stripe.test/z' })
  await act(async () => root.render(<UpgradeModal onClose={() => {}} />))

  await act(async () => button('Continue to checkout')!.click())
  expect(api.createWorkspace).toHaveBeenCalled()
  expect(api.workspaceCheckout).toHaveBeenCalledWith('new', 'month', 1)
})
