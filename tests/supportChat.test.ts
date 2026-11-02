// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('posthog-js/dist/posthog-recorder', () => ({}))
vi.mock('posthog-js/dist/exception-autocapture', () => ({}))
vi.mock('posthog-js/dist/web-vitals', () => ({}))
vi.mock('posthog-js/dist/conversations', () => ({}))
vi.mock('../src/lib/frameReplay', () => ({ installFrameReplay: vi.fn() }))
vi.mock('posthog-js/dist/module.no-external', () => ({
  default: {
    init: vi.fn(),
    conversations: { isAvailable: () => true, show: vi.fn(), hide: vi.fn() },
  },
}))

const containerId = 'ph-conversations-widget-container'
const launcher = () => document.querySelector<HTMLButtonElement>('button[aria-label="Open chat"]')
const closeButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
let support: typeof import('../src/lib/posthog')
let savedOpen = false

// The SDK mounts on show(), removes on hide(), and restores the saved panel state.
function mountWidget() {
  if (document.getElementById(containerId)) return
  const container = document.createElement('div')
  container.id = containerId
  const render = () => {
    const button = document.createElement('button')
    button.setAttribute('aria-label', savedOpen ? 'Close' : 'Open chat')
    button.onclick = () => {
      savedOpen = !savedOpen
      queueMicrotask(render)
    }
    container.replaceChildren(button)
  }
  document.body.append(container)
  render()
}

beforeEach(async () => {
  vi.stubEnv('VITE_POSTHOG_KEY', 'test-key')
  support ??= await import('../src/lib/posthog')
  savedOpen = false
  vi.mocked(support.posthog.conversations.show).mockImplementation(mountWidget)
  vi.mocked(support.posthog.conversations.hide).mockImplementation(() => {
    document.getElementById(containerId)?.remove()
  })
  support.setSupportWidgetVisible(false)
})

afterEach(() => {
  support.setSupportWidgetVisible(true)
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('opens from the canvas, hides on close, and can be opened again', async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(support.openSupportChat()).toBe(true)
    await vi.waitFor(() => expect(closeButton()).not.toBeNull())
    closeButton()!.click()
    await vi.waitFor(() => expect(document.getElementById(containerId)).toBeNull())
  }
})

it('still hides a widget that mounts after the canvas has loaded', async () => {
  mountWidget()
  await vi.waitFor(() => expect(document.getElementById(containerId)).toBeNull())
})

it('opens when the SDK finishes mounting asynchronously', async () => {
  vi.mocked(support.posthog.conversations.show).mockImplementation(() => {})
  support.openSupportChat()
  await new Promise(requestAnimationFrame)
  mountWidget()
  await vi.waitFor(() => expect(closeButton()).not.toBeNull())
})

it('restores canvas hiding if the widget does not mount before the timeout', async () => {
  vi.mocked(support.posthog.conversations.show).mockImplementation(() => {})
  support.openSupportChat()
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3001)
  await new Promise(requestAnimationFrame)
  mountWidget()
  await vi.waitFor(() => expect(document.getElementById(containerId)).toBeNull())
})

it('handles a restored open panel and repeated Contact Support clicks', async () => {
  savedOpen = true
  support.openSupportChat()
  support.openSupportChat()
  await vi.waitFor(() => expect(closeButton()).not.toBeNull())
  // Let the opener attach its close observer before closing the restored panel.
  await new Promise(requestAnimationFrame)
  closeButton()!.click()
  await vi.waitFor(() => expect(document.getElementById(containerId)).toBeNull())
})

it('keeps the launcher visible when chat is closed outside the canvas', async () => {
  support.setSupportWidgetVisible(true)
  support.openSupportChat()
  await vi.waitFor(() => expect(closeButton()).not.toBeNull())
  closeButton()!.click()
  await vi.waitFor(() => expect(launcher()).not.toBeNull())
})

it('cancels a pending open when the route changes', async () => {
  support.openSupportChat()
  support.setSupportWidgetVisible(true)
  await new Promise(requestAnimationFrame)
  expect(launcher()).not.toBeNull()
  expect(closeButton()).toBeNull()
})
