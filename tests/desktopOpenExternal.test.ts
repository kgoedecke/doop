// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../src/App', () => ({ navigate: vi.fn() }))
vi.mock('../src/lib/auth', () => ({ authClient: {} }))
vi.mock('../src/lib/shell', () => ({ isDesktopShell: () => true }))
import { beginBrowserSignIn, openExternal } from '../src/lib/desktop'
import { isPendingSignIn } from '../src/lib/desktopAuth'

type Shell = { __TAURI__?: unknown; __DOOP_OPEN_EXTERNAL__?: boolean }
const shell = window as Window & Shell

afterEach(() => {
  delete shell.__TAURI__
  delete shell.__DOOP_OPEN_EXTERNAL__
  localStorage.clear()
})

function stubShell({ openExternalCommand }: { openExternalCommand: boolean }) {
  const invoke = vi.fn(async () => undefined)
  const openUrl = vi.fn(async () => undefined)
  shell.__TAURI__ = { core: { invoke }, opener: { openUrl } }
  if (openExternalCommand) shell.__DOOP_OPEN_EXTERNAL__ = true
  return { invoke, openUrl }
}

it("opens links through the shell's own command where it has one", () => {
  const { invoke, openUrl } = stubShell({ openExternalCommand: true })
  expect(openExternal('https://doop.design/docs')).toBe(true)
  expect(invoke).toHaveBeenCalledWith('open_external', { url: 'https://doop.design/docs' })
  expect(openUrl).not.toHaveBeenCalled()
})

it('falls back to the opener plugin on a shell from before the command', () => {
  const { invoke, openUrl } = stubShell({ openExternalCommand: false })
  expect(openExternal('https://doop.design/docs')).toBe(true)
  expect(openUrl).toHaveBeenCalledWith('https://doop.design/docs')
  expect(invoke).not.toHaveBeenCalled()
})

it('leaves mail and phone links to the caller', () => {
  const { invoke, openUrl } = stubShell({ openExternalCommand: true })
  expect(openExternal('mailto:hi@example.com')).toBe(false)
  expect(openExternal('tel:+4930123')).toBe(false)
  expect(invoke).not.toHaveBeenCalled()
  expect(openUrl).not.toHaveBeenCalled()
})

it('opens nothing outside a shell with IPC', () => {
  expect(openExternal('https://doop.design/docs')).toBe(false)
})

it('sends the sign-in to the browser through the command, and forgets it when the browser cannot open', async () => {
  const { invoke } = stubShell({ openExternalCommand: true })
  const redirects = { callbackURL: '/', newUserCallbackURL: '/' }
  expect(await beginBrowserSignIn('google', redirects)).toBe(true)
  const [command, args] = invoke.mock.calls[0] as unknown as [string, { url: string }]
  expect(command).toBe('open_external')
  const challenge = new URL(args.url).searchParams.get('challenge')!
  expect(new URL(args.url).pathname).toBe('/desktop/signin')
  expect(isPendingSignIn(challenge)).toBe(true)

  invoke.mockRejectedValueOnce(new Error('no xdg-open'))
  vi.spyOn(console, 'error').mockImplementationOnce(() => {})
  expect(await beginBrowserSignIn('google', redirects)).toBe(false)
  const [, failed] = invoke.mock.calls[1] as unknown as [string, { url: string }]
  expect(isPendingSignIn(new URL(failed.url).searchParams.get('challenge')!)).toBe(false)
})
