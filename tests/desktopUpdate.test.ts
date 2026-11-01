import { afterEach, expect, it, vi } from 'vitest'
import { UPDATE_READY_EVENT, isUpdateOffer, listenForUpdates, restartToUpdate } from '../src/lib/desktopUpdate'

afterEach(() => vi.unstubAllGlobals())

type Handler = (event: { payload: unknown }) => void

function stubShell() {
  const handlers = new Map<string, Handler>()
  const unlisten = vi.fn()
  const calls: string[] = []
  const invoke = vi.fn((command: string) => {
    calls.push(`invoke:${command}`)
    return Promise.resolve()
  })
  const listen = vi.fn((name: string, handler: Handler) => {
    calls.push(`listen:${name}`)
    handlers.set(name, handler)
    return Promise.resolve(unlisten)
  })
  vi.stubGlobal('__TAURI__', { core: { invoke }, event: { listen } })
  vi.stubGlobal('__DOOP_UPDATE_CARD__', true)
  return { handlers, unlisten, calls, invoke, listen }
}

const flush = () => new Promise((resolve) => setTimeout(resolve))

it('accepts only an offer naming both versions', () => {
  expect(isUpdateOffer({ version: '0.11.0', current: '0.10.0' })).toBe(true)
  expect(isUpdateOffer({ version: '0.11.0' })).toBe(false)
  expect(isUpdateOffer(null)).toBe(false)
})

it('tells the shell it draws the card only once it is listening', async () => {
  const shell = stubShell()
  const onOffer = vi.fn()
  const stop = listenForUpdates(onOffer)
  await flush()
  expect(shell.calls).toEqual([`listen:${UPDATE_READY_EVENT}`, 'invoke:update_card_ready'])
  shell.handlers.get(UPDATE_READY_EVENT)?.({ payload: { version: '0.11.0', current: '0.10.0' } })
  shell.handlers.get(UPDATE_READY_EVENT)?.({ payload: 'garbage' })
  expect(onOffer.mock.calls).toEqual([[{ version: '0.11.0', current: '0.10.0' }]])
  stop()
  expect(shell.unlisten).toHaveBeenCalled()
})

it('does not claim the card when unsubscribed before the listener is in place', async () => {
  const shell = stubShell()
  listenForUpdates(vi.fn())()
  await flush()
  expect(shell.unlisten).toHaveBeenCalled()
  expect(shell.invoke).not.toHaveBeenCalled()
})

it('asks the shell to install and restart', async () => {
  const shell = stubShell()
  await restartToUpdate()
  expect(shell.invoke).toHaveBeenCalledWith('update_restart')
})

it('does nothing in a shell older than the card, or outside one', async () => {
  const shell = stubShell()
  vi.stubGlobal('__DOOP_UPDATE_CARD__', undefined)
  listenForUpdates(vi.fn())
  await restartToUpdate()
  vi.unstubAllGlobals()
  listenForUpdates(vi.fn())
  await restartToUpdate()
  await flush()
  expect(shell.listen).not.toHaveBeenCalled()
  expect(shell.invoke).not.toHaveBeenCalled()
})
