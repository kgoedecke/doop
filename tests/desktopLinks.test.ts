// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), verify: vi.fn() }))
vi.mock('../src/App', () => ({ navigate: mocks.navigate }))
vi.mock('../src/lib/auth', () => ({ authClient: { oneTimeToken: { verify: mocks.verify } } }))
vi.mock('../src/lib/shell', () => ({ isDesktopShell: () => true }))
import { initDesktopShell } from '../src/lib/desktop'
import { codexDesktopLink, codexSetupTarget } from '../src/lib/codexConnection'

it('routes both launch and running-app Codex links without installing or redeeming sign-in tokens', async () => {
  const handlers = new Map<string, (event: { payload: string[] }) => void>()
  const link = codexDesktopLink('https://doop.design', 'first-canvas')
  const listener = vi.spyOn(document, 'addEventListener')
  const target = window as Window & { __TAURI__?: unknown }
  target.__TAURI__ = {
    event: {
      listen: async (name: string, handler: (event: { payload: string[] }) => void) => {
        handlers.set(name, handler)
      },
    },
    deepLink: { getCurrent: async () => [link] },
  }
  try {
    initDesktopShell()
    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith(codexSetupTarget(link)))
    const next = codexDesktopLink('https://doop.design', 'second-canvas')
    handlers.get('deep-link://new-url')!({ payload: [next] })
    expect(mocks.navigate).toHaveBeenLastCalledWith(codexSetupTarget(next))
    handlers.get('deep-link://new-url')!({ payload: ['doop://connect/unknown'] })
    expect(mocks.navigate).toHaveBeenCalledTimes(2)
    expect(mocks.verify).not.toHaveBeenCalled()
  } finally {
    for (const [name, handler, options] of listener.mock.calls) document.removeEventListener(name, handler, options)
    listener.mockRestore()
    delete target.__TAURI__
  }
})
