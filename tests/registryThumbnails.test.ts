import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), render: vi.fn() }))
vi.mock('../server/shadcnRegistry.ts', () => ({ prepareRegistryImport: mocks.prepare }))
vi.mock('../server/registryRenderer.ts', () => ({ renderRegistryComponent: mocks.render }))
import { registryThumbnail, resetRegistryThumbnails, ThumbnailBusyError } from '../server/registryThumbnails.ts'
import { registryTheme } from '../server/registryTheme.ts'

const source = 'https://magic.example/r/registry.json'

beforeEach(() => {
  resetRegistryThumbnails()
  /* no item has a demo unless a test says so */
  mocks.prepare.mockReset().mockImplementation(async ([selection]: { name: string }[]) => {
    if (selection?.name.endsWith('-demo')) throw new Error('no longer available')
    return { selected: [{ name: selection?.name }], items: [{ name: selection?.name }] }
  })
  mocks.render.mockReset().mockImplementation(async (item: { name: string }) => ({ image: Buffer.from(item.name) }))
})

it('pictures the registry’s demo of an item when it has one', async () => {
  mocks.prepare.mockImplementation(async ([selection]: { name: string }[]) => {
    if (selection?.name === 'plain-demo') throw new Error('no longer available')
    return { selected: [{ name: selection?.name }], items: [] }
  })
  expect(String(await registryThumbnail(source, 'marquee'))).toBe('marquee-demo')
  expect(String(await registryThumbnail(source, 'plain'))).toBe('plain')
})

it('looks for the demo beside an item read from its own URL', async () => {
  mocks.prepare.mockImplementation(async ([selection]: { source: string; name: string }[]) => {
    if (selection?.name === 'marquee-demo' && selection.source !== 'https://magic.example/r/marquee-demo.json')
      throw new Error('no longer available')
    return { selected: [{ name: selection?.name }], items: [] }
  })
  expect(String(await registryThumbnail('https://magic.example/r/marquee.json', 'marquee'))).toBe('marquee-demo')
})

it('falls back to the item itself when its demo cannot render', async () => {
  mocks.prepare.mockImplementation(async ([selection]: { name: string }[]) => ({
    selected: [{ name: selection?.name }],
    items: [],
  }))
  mocks.render.mockImplementation(async (item: { name: string }) => {
    if (item.name.endsWith('-demo')) throw new Error('needs an image host')
    return { image: Buffer.from(item.name) }
  })
  expect(String(await registryThumbnail(source, 'beam'))).toBe('beam')
})

it('renders an item once with an image and serves it from the cache after', async () => {
  expect(String(await registryThumbnail(source, 'marquee'))).toBe('marquee')
  expect(String(await registryThumbnail(source, 'marquee'))).toBe('marquee')
  expect(mocks.render).toHaveBeenCalledOnce()
  expect(mocks.render.mock.calls[0]?.[3]).toEqual({ image: true })
})

it('keeps a themed picture apart from the plain one', async () => {
  const theme = registryTheme([
    { name: '--color-brand', type: 'color', value: 'red', order: 0, updatedAt: 0, updatedBy: 't' },
  ])
  await registryThumbnail(source, 'marquee')
  await registryThumbnail(source, 'marquee', theme)
  expect(mocks.render).toHaveBeenCalledTimes(2)
  expect(mocks.render.mock.calls[1]?.[2]).toBe(theme)
})

it('remembers a failure for a while instead of re-rendering on every scroll', async () => {
  mocks.render.mockRejectedValue(new Error('needs providers'))
  await expect(registryThumbnail(source, 'broken')).rejects.toThrow('needs providers')
  await expect(registryThumbnail(source, 'broken')).rejects.toThrow('needs providers')
  expect(mocks.render).toHaveBeenCalledOnce()
})

it('runs a few renders at a time and turns away a flood', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let peak = 0
  let now = 0
  mocks.render.mockImplementation(async (item: { name: string }) => {
    peak = Math.max(peak, ++now)
    await gate
    now--
    return { image: Buffer.from(item.name) }
  })
  const all = Array.from({ length: 63 }, (_, i) => registryThumbnail(source, `item-${i}`))
  const busy = registryThumbnail(source, 'one-too-many')
  await expect(busy).rejects.toBeInstanceOf(ThumbnailBusyError)
  release()
  await Promise.all(all)
  expect(peak).toBe(3)
  /* turned away for being busy, not for being broken: asked again, it renders */
  expect(String(await registryThumbnail(source, 'one-too-many'))).toBe('one-too-many')
})
