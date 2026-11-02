// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AdminUser, AgentKeyInfo } from '../src/lib/api'
import type { WebhookInfo } from '../shared/webhooks'

/* The destructive actions below used to gate on window.confirm, which the
   desktop shell's webview answers with a silent "cancel". They now confirm in
   an in-app ConfirmDialog: cancelling must send nothing, and confirming must
   send exactly one request for the row that was clicked. */

const mocks = vi.hoisted(() => ({
  listAgentKeys: vi.fn(),
  deleteAgentKey: vi.fn(),
  listWebhooks: vi.fn(),
  rotateWebhookSecret: vi.fn(),
  deleteWebhook: vi.fn(),
  adminUsers: vi.fn(),
  ban: vi.fn(),
  unban: vi.fn(),
}))

vi.mock('../src/App', () => ({ navigate: vi.fn() }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
/* the rail pulls in auth, workspaces and modals — none of it is under test */
vi.mock('../src/components/AppRail', () => ({
  AppRail: ({ children }: { children?: ReactNode }) => <aside>{children}</aside>,
  railLayout: '',
}))
vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      listAgentKeys: mocks.listAgentKeys,
      deleteAgentKey: mocks.deleteAgentKey,
      listWebhooks: mocks.listWebhooks,
      rotateWebhookSecret: mocks.rotateWebhookSecret,
      deleteWebhook: mocks.deleteWebhook,
    },
    adminApi: {
      ...actual.adminApi,
      canvases: () => Promise.resolve({ total: 0, canvases: [] }),
      stats: () => Promise.resolve({ users: 2, canvases: 0, frames: 0 }),
      users: mocks.adminUsers,
      ban: mocks.ban,
      unban: mocks.unban,
    },
  }
})

import { AgentKeys } from '../src/components/AgentKeys'
import { Webhooks } from '../src/components/Webhooks'
import { Admin } from '../src/pages/Admin'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

const dialog = () => document.body.querySelector('[role="alertdialog"]')
function button(label: string, scope: ParentNode = document.body): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label,
  )
  if (!found) throw new Error(`no button "${label}"`)
  return found
}
async function click(label: string, scope?: ParentNode) {
  await act(async () => button(label, scope).click())
}
async function mount(node: ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(node))
}

const key = (id: string, name: string): AgentKeyInfo => ({ id, name, start: 'dpk_abc', createdAt: 0, lastUsedAt: null })
const hook = (id: string, url: string): WebhookInfo => ({
  id,
  url,
  events: [],
  enabled: true,
  createdAt: 0,
  lastStatus: null,
  lastAt: null,
  lastError: null,
  failures: 0,
})
const user = (id: string, name: string, banned: boolean): AdminUser => ({
  id,
  name,
  email: `${id}@example.com`,
  role: null,
  banned,
  createdAt: 0,
  canvasCount: 0,
})

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset()
  mocks.deleteAgentKey.mockResolvedValue({ ok: true })
  mocks.rotateWebhookSecret.mockResolvedValue({ secret: 'whsec_new' })
  mocks.deleteWebhook.mockResolvedValue({ ok: true })
  mocks.ban.mockResolvedValue({})
  mocks.unban.mockResolvedValue({})
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

it('revokes an agent key only after the dialog is confirmed', async () => {
  mocks.listAgentKeys.mockResolvedValue([key('k1', 'ci'), key('k2', 'mastra')])
  await mount(<AgentKeys />)

  await click('Revoke mastra')
  expect(dialog()?.textContent).toContain('Revoke “mastra”?')
  await click('Cancel', dialog()!)
  expect(dialog()).toBeNull()
  expect(mocks.deleteAgentKey).not.toHaveBeenCalled()

  await click('Revoke mastra')
  await click('Revoke key', dialog()!)
  expect(mocks.deleteAgentKey).toHaveBeenCalledTimes(1)
  expect(mocks.deleteAgentKey).toHaveBeenCalledWith('k2')
  expect(container.textContent).not.toContain('mastra')
  expect(container.textContent).toContain('ci')
})

it('rotates a webhook secret only after the dialog is confirmed', async () => {
  mocks.listWebhooks.mockResolvedValue([hook('h1', 'https://hooks.example.com/doop')])
  await mount(<Webhooks />)

  await click('Rotate secret')
  expect(dialog()?.textContent).toContain('Rotate the secret for hooks.example.com?')
  await click('Cancel', dialog()!)
  expect(mocks.rotateWebhookSecret).not.toHaveBeenCalled()

  await click('Rotate secret')
  await click('Rotate secret', dialog()!)
  expect(mocks.rotateWebhookSecret).toHaveBeenCalledTimes(1)
  expect(mocks.rotateWebhookSecret).toHaveBeenCalledWith('h1')
  expect(mocks.deleteWebhook).not.toHaveBeenCalled()
  expect(container.textContent).toContain('whsec_new')
})

it('removes a webhook only after the dialog is confirmed', async () => {
  mocks.listWebhooks.mockResolvedValue([
    hook('h1', 'https://hooks.example.com/doop'),
    hook('h2', 'https://n8n.example.org/webhook'),
  ])
  await mount(<Webhooks />)

  await click('Remove webhook for n8n.example.org')
  expect(dialog()?.textContent).toContain('Remove the webhook for n8n.example.org?')
  await click('Cancel', dialog()!)
  expect(mocks.deleteWebhook).not.toHaveBeenCalled()

  await click('Remove webhook for n8n.example.org')
  await click('Remove webhook', dialog()!)
  expect(mocks.deleteWebhook).toHaveBeenCalledTimes(1)
  expect(mocks.deleteWebhook).toHaveBeenCalledWith('h2')
  expect(mocks.rotateWebhookSecret).not.toHaveBeenCalled()
  expect(container.textContent).not.toContain('n8n.example.org')
})

it('bans and unbans accounts from /admin only after the dialog is confirmed', async () => {
  mocks.adminUsers.mockResolvedValue([user('u1', 'Ada', false), user('u2', 'Grace', true)])
  await mount(<Admin />)
  /* the rail item also renders its count, so match the label as a prefix */
  const accounts = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Accounts'))!
  await act(async () => accounts.click())

  /* each account row's own Ban/Unban button: climb from the button to the
     widest ancestor that still holds no other ban control, then match its text */
  const banButtons = () =>
    Array.from(container.querySelectorAll('button')).filter((b) => /^(Ban|Unban)$/.test(b.textContent?.trim() ?? ''))
  const rowAction = (name: string) =>
    banButtons().find((b) => {
      let row: HTMLElement = b
      while (row.parentElement && banButtons().filter((x) => row.parentElement!.contains(x)).length === 1)
        row = row.parentElement
      return row.textContent?.includes(name)
    })!

  await act(async () => rowAction('Ada').click())
  expect(dialog()?.textContent).toContain('Ban Ada (u1@example.com)?')
  await click('Cancel', dialog()!)
  expect(mocks.ban).not.toHaveBeenCalled()

  await act(async () => rowAction('Ada').click())
  await click('Ban', dialog()!)
  expect(mocks.ban).toHaveBeenCalledTimes(1)
  expect(mocks.ban).toHaveBeenCalledWith('u1')

  await act(async () => rowAction('Grace').click())
  expect(dialog()?.textContent).toContain('Unban Grace (u2@example.com)?')
  await click('Unban', dialog()!)
  expect(mocks.unban).toHaveBeenCalledTimes(1)
  expect(mocks.unban).toHaveBeenCalledWith('u2')
  expect(mocks.ban).toHaveBeenCalledTimes(1)
})
