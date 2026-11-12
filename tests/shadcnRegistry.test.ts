import { beforeEach, describe, expect, it, vi } from 'vitest'

const network = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('../server/publicUrl.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/publicUrl.ts')>()),
  fetchPinnedPublicUrl: network.fetch,
}))
import { prepareRegistryImport, previewRegistry } from '../server/shadcnRegistry.ts'

const root = 'https://registry.example/r/registry.json'
const button = {
  name: 'button',
  type: 'registry:ui',
  files: [{ path: 'ui/button.tsx', content: 'export const Button = () => <button>Buy</button>' }],
}
const card = {
  name: 'card',
  type: 'registry:ui',
  files: [{ path: 'ui/card.tsx', content: 'export const Card = () => <div />' }],
}

function respond(routes: Record<string, unknown>) {
  network.fetch.mockImplementation(async (raw: string | URL) => {
    const value = routes[String(raw)]
    if (value instanceof Response) return value
    return value ? Response.json(value) : new Response('missing', { status: 404 })
  })
}

beforeEach(() => network.fetch.mockReset())

describe('shadcn registry imports', () => {
  it('previews index metadata without exposing source or fetching unselected items', async () => {
    respond({ [root]: { name: 'Acme', items: [button, card] } })
    expect(await previewRegistry(root)).toEqual({
      url: root,
      name: 'Acme',
      items: [
        { name: 'button', title: 'button', description: '', type: 'registry:ui' },
        { name: 'card', title: 'card', description: '', type: 'registry:ui' },
      ],
    })
    expect(network.fetch).toHaveBeenCalledTimes(1)
  })

  it('resolves direct item URLs with their theme data and package metadata', async () => {
    respond({ [root]: { ...button, cssVars: { light: { primary: 'red' } }, dependencies: ['@radix-ui/react-slot'] } })
    const result = await prepareRegistryImport(root, ['button'])
    expect(result.selected[0]?.files?.[0]?.path).toBe('ui/button.tsx')
    expect(result.selected[0]?.dependencies).toEqual(['@radix-ui/react-slot'])
    expect(result.selected[0]?.cssVars).toEqual({ light: { primary: 'red' } })
    expect(result.selected.map((item) => item.name)).toEqual(['button'])
  })

  it('resolves selected items and local dependency cycles once without importing unrelated items', async () => {
    respond({
      [root]: {
        name: 'Acme',
        items: [
          { ...button, registryDependencies: ['card'] },
          { ...card, registryDependencies: ['button'] },
          { name: 'unused', type: 'registry:ui', files: [{ path: 'unused.tsx' }] },
        ],
      },
    })
    const result = await prepareRegistryImport(root, ['button'])
    expect(result.items.map((item) => item.name)).toEqual(['button', 'card'])
    expect(result.selected.map((item) => item.name)).toEqual(['button'])
    expect(network.fetch).toHaveBeenCalledTimes(1)
  })

  it('fetches published item JSON when an index contains paths without contents', async () => {
    respond({
      [root]: { name: 'Acme', items: [{ ...button, files: [{ path: 'ui/button.tsx' }] }] },
      'https://registry.example/r/button.json': button,
    })
    expect((await prepareRegistryImport(root, ['button'])).selected[0]?.files?.[0]?.content).toContain(
      'export const Button',
    )
    expect(network.fetch).toHaveBeenCalledTimes(2)
  })

  it('resolves public URL and standard shadcn dependencies', async () => {
    respond({
      [root]: { ...button, registryDependencies: ['https://other.example/card.json', 'input'] },
      'https://other.example/card.json': card,
      'https://ui.shadcn.com/r/styles/new-york-v4/input.json': { ...card, name: 'input' },
    })
    expect((await prepareRegistryImport(root, ['button'])).items.map((item) => item.name)).toEqual([
      'button',
      'card',
      'input',
    ])
  })

  it('rejects missing selections, invalid registries and unresolved namespaces', async () => {
    respond({ [root]: { name: 'Acme', items: [button] } })
    await expect(prepareRegistryImport(root, ['gone'])).rejects.toThrow('no longer available')
    await expect(prepareRegistryImport(root, [])).rejects.toThrow('Select between')
    await expect(prepareRegistryImport(root, ['button', 'button'])).rejects.toThrow('distinct')
    respond({ [root]: { ...button, registryDependencies: ['@private/card'] } })
    await expect(prepareRegistryImport(root, ['button'])).rejects.toThrow('Cannot resolve')
    respond({ [root]: { hello: 'world' } })
    await expect(previewRegistry(root)).rejects.toThrow('Expected a shadcn')
  })

  it('blocks private URLs and private redirect targets before fetching them', async () => {
    await expect(previewRegistry('http://127.0.0.1/registry.json')).rejects.toThrow()
    expect(network.fetch).not.toHaveBeenCalled()
    respond({ [root]: new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/internal' } }) })
    await expect(previewRegistry(root)).rejects.toThrow()
    expect(network.fetch).toHaveBeenCalledTimes(1)
  })

  it('limits downloaded bytes and source size', async () => {
    respond({ [root]: new Response('huge', { headers: { 'content-length': '2000001' } }) })
    await expect(previewRegistry(root)).rejects.toThrow('too large')
    respond({ [root]: { ...button, files: [{ path: 'big.tsx', content: 'x'.repeat(50_000) }] } })
    expect((await prepareRegistryImport(root, ['button'])).selected[0]?.files?.[0]?.content?.length).toBe(50_000)
    respond({ [root]: { ...button, files: [{ path: 'huge.tsx', content: 'x'.repeat(160_000) }] } })
    await expect(prepareRegistryImport(root, ['button'])).rejects.toThrow('too large')
  })
})
