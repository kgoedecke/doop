// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../src/App', () => ({ navigate: vi.fn() }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/store', () => ({
  useStore: (select: (s: { presences: Record<string, never> }) => unknown) => select({ presences: {} }),
}))
import { ConnectModal } from '../src/components/ConnectModal'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
const text = () => document.body.textContent ?? ''
const link = (label: string) =>
  Array.from(document.body.querySelectorAll('a')).find((a) => a.textContent?.trim() === label)

async function openChatGPT(origin: string, canvasId?: string) {
  vi.stubGlobal('location', { origin })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<ConnectModal canvasId={canvasId} onClose={vi.fn()} />))
  await act(async () => {
    document.body.querySelector<HTMLButtonElement>('button[aria-pressed]:nth-child(3)')!.click()
  })
  await act(async () => {
    Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Connect')!
      .click()
  })
}

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('opens the official ChatGPT setup and copies the production MCP URL without downloading a file', async () => {
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  await openChatGPT('https://doop.design', 'canvas-1')
  expect(link('Open ChatGPT setup')?.href).toBe('https://chatgpt.com/plugins')
  expect(link('Open ChatGPT setup')?.target).toBe('_blank')
  expect(link('Open ChatGPT setup')?.rel).toBe('noopener noreferrer')
  expect(text()).toContain('Add custom MCP server')
  expect(text()).toContain('Create as a plugin')
  expect(text()).toContain('OAuth')
  expect(text()).toContain('Work on Doop canvas canvas-1.')
  expect(text()).toContain('listening for ChatGPT')
  expect(document.body.querySelector('a[download]')).toBeNull()

  const serverBlock = Array.from(document.body.querySelectorAll('[data-slot="code-block"]')).find((block) =>
    block.textContent?.startsWith('https://doop.design/mcp'),
  )!
  await act(async () => serverBlock.querySelector('button')!.click())
  expect(writeText).toHaveBeenCalledWith('https://doop.design/mcp')
  expect(serverBlock.querySelector('button')?.getAttribute('aria-label')).toBe('Copied')
})

it.each([
  'https://design.acme.com:8443',
  'https://10.design.example.com',
  'https://127.design.example.com',
  'https://192.168.design.example.com',
  'https://172.16.design.example.com',
  'https://[2606:4700:4700::1111]',
  'https://[::ffff:808:808]',
])('offers setup for the public self-hosted instance %s from the dashboard', async (origin) => {
  await openChatGPT(origin)
  expect(link('Open ChatGPT setup')).toBeDefined()
  expect(text()).toContain(`${origin}/mcp`)
  expect(text()).not.toContain('https://doop.design/mcp')
  expect(text()).not.toContain('Work on Doop canvas')
  expect(text()).not.toContain('listening for ChatGPT')
  expect(text()).toContain('tell it which canvas to work on')
})

it.each([
  'http://localhost:4301',
  'https://localhost.',
  'https://127.0.0.1',
  'https://192.168.1.2',
  'https://10.0.0.1',
  'https://172.16.1.2',
  'https://[::1]',
  'https://[::]',
  'https://[fc00::1]',
  'https://[fd12::1]',
  'https://[fe80::1]',
  'https://[febf::1]',
  'https://[::ffff:7f00:1]',
  'https://[::ffff:c0a8:102]',
  'https://[::ffff:ac10:102]',
  'https://doop.local',
  'https://doop.home.arpa',
  'http://design.acme.com',
])('explains how to make %s reachable instead of suggesting a direct cloud connection', async (origin) => {
  await openChatGPT(origin, 'local-canvas')
  expect(link('Open ChatGPT setup')).toBeUndefined()
  expect(link('View ChatGPT setup guide')?.href).toBe('https://developers.openai.com/plugins/deploy/connect-chatgpt')
  expect(text()).toContain('ChatGPT cannot reach this address directly')
  expect(text()).toContain('OpenAI Secure MCP Tunnel')
  expect(text()).not.toContain('Work on Doop canvas')
  expect(text()).not.toContain('https://doop.design/mcp')
})
