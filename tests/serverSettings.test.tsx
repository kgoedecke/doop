// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ServerSettings } from '../src/components/ServerSettings'
import { canChooseServer, chooseServer, serverErrorMessage, serverHost } from '../src/lib/desktopServer'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Bridge = { __DOOP_SERVER_CHOOSE__?: boolean; __TAURI__?: unknown }
const g = globalThis as Bridge

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete g.__DOOP_SERVER_CHOOSE__
  delete g.__TAURI__
})

function shell(status: { url: string; defaultUrl: string; custom: boolean }, choose: (url: string) => unknown) {
  const invoke = vi.fn(async (command: string, args?: { url: string }) => {
    if (command === 'server_status') return status
    if (command === 'server_choose') return choose(args!.url)
    throw new Error(`unexpected ${command}`)
  })
  g.__DOOP_SERVER_CHOOSE__ = true
  g.__TAURI__ = { core: { invoke } }
  return invoke
}

async function openSettings() {
  await act(async () => root.render(<ServerSettings />))
  const cog = document.querySelector<HTMLButtonElement>('button[aria-label="Server settings"]')!
  await act(async () => cog.click())
  return document.querySelector<HTMLInputElement>('input[aria-label="Server address"]')!
}

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function button(label: string) {
  return [...document.querySelectorAll('button')].find((b) => b.textContent === label)
}

describe('the desktop server bridge', () => {
  it('is offered only in a shell that advertises it and carries the Tauri bridge', async () => {
    expect(canChooseServer()).toBe(false)
    await expect(chooseServer('https://doop.example.com')).rejects.toThrow(/desktop app/)
    g.__DOOP_SERVER_CHOOSE__ = true
    expect(canChooseServer()).toBe(false)
    g.__TAURI__ = { core: { invoke: vi.fn() } }
    expect(canChooseServer()).toBe(true)
  })

  it('shows the shell’s own reason and names servers by host', () => {
    expect(serverErrorMessage('No Doop server answered.', 'fallback')).toBe('No Doop server answered.')
    expect(serverErrorMessage(new Error('boom'), 'fallback')).toBe('boom')
    expect(serverErrorMessage({}, 'fallback')).toBe('fallback')
    expect(serverHost('https://doop.example.com')).toBe('doop.example.com')
    expect(serverHost('http://localhost:4400')).toBe('localhost:4400')
  })
})

describe('the sign-in screen’s server settings', () => {
  it('draws no cog in a browser', async () => {
    await act(async () => root.render(<ServerSettings />))
    expect(container.innerHTML).toBe('')
  })

  it('opens on the current server and hands the typed address to the shell', async () => {
    const invoke = shell({ url: 'https://doop.design', defaultUrl: 'https://doop.design', custom: false }, () => true)
    const input = await openSettings()
    expect(input.value).toBe('https://doop.design')
    expect(document.body.textContent).toContain('connected to doop.design')
    expect(button('Use doop.design')).toBeUndefined()
    await act(async () => setValue(input, 'doop.example.com'))
    await act(async () => button('Connect')!.click())
    expect(invoke).toHaveBeenCalledWith('server_choose', { url: 'doop.example.com' })
    /* restarting: the form stays busy until the app goes away */
    expect(button('Checking…')?.disabled).toBe(true)
  })

  it('shows why the shell refused, and is usable again', async () => {
    shell({ url: 'https://doop.design', defaultUrl: 'https://doop.design', custom: false }, () =>
      Promise.reject('No Doop server answered at https://nope.example.'),
    )
    const input = await openSettings()
    await act(async () => setValue(input, 'nope.example'))
    await act(async () => button('Connect')!.click())
    expect(document.body.textContent).toContain('No Doop server answered at https://nope.example.')
    expect(button('Connect')?.disabled).toBe(false)
  })

  it('offers the way back while another server is chosen', async () => {
    const invoke = shell(
      { url: 'https://doop.example.com', defaultUrl: 'https://doop.design', custom: true },
      () => false,
    )
    await openSettings()
    await act(async () => button('Use doop.design')!.click())
    expect(invoke).toHaveBeenCalledWith('server_choose', { url: 'https://doop.design' })
    /* a cancelled dialog leaves the form as it was */
    expect(button('Connect')?.disabled).toBe(false)
  })
})
