import { beforeEach, describe, expect, it, vi } from 'vitest'

const network = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('../server/publicUrl.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/publicUrl.ts')>()),
  fetchPinnedPublicUrl: network.fetch,
}))
import {
  DIRECTORY_URL,
  prepareRegistryImport,
  previewRegistry,
  registryDirectory,
  resetRegistryDirectory,
} from '../server/shadcnRegistry.ts'
import { isRegistryPaste, registrySpecs } from '../shared/shadcnRegistry.ts'

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
const directory = [
  { name: '@magic', homepage: 'https://magic.example', url: 'https://magic.example/r/{name}', description: 'Animated' },
  { name: '@styled', homepage: 'https://styled.example', url: 'https://styled.example/r/{style}/{name}.json' },
  { name: '@ace', homepage: 'https://ace.example', url: 'https://ace.example/registry/{name}.json' },
  { name: '@gone', url: 'https://gone.example/r/{name}.json', health: { hidden: true } },
]

function respond(routes: Record<string, unknown>) {
  resetRegistryDirectory()
  network.fetch.mockImplementation(async (raw: string | URL) => {
    const value = { [DIRECTORY_URL]: directory, ...routes }[String(raw)]
    if (value instanceof Response) return value
    if (typeof value === 'string') return new Response(value, { headers: { 'content-type': 'text/html' } })
    return value ? Response.json(value) : new Response('missing', { status: 404 })
  })
}
/** registry fetches, leaving out the directory lookup */
const fetched = () => network.fetch.mock.calls.map(([url]) => String(url)).filter((url) => url !== DIRECTORY_URL)
const only = (...names: string[]) => names.map((name) => ({ source: root, name }))

beforeEach(() => {
  network.fetch.mockReset()
  resetRegistryDirectory()
})

describe('what a paste names', () => {
  it('reads install commands, namespaced items and registry URLs', () => {
    expect(registrySpecs('npx shadcn@latest add @magicui/marquee')).toEqual(['@magicui/marquee'])
    expect(registrySpecs('pnpm dlx shadcn@latest add card dialog --overwrite')).toEqual(['card', 'dialog'])
    expect(registrySpecs('bunx --bun shadcn add "https://x.dev/r/a.json"')).toEqual(['https://x.dev/r/a.json'])
    expect(registrySpecs('@aceternity/3d-card')).toEqual(['@aceternity/3d-card'])
    expect(registrySpecs('card')).toBeNull()
    expect(registrySpecs('hello there friend')).toBeNull()
  })

  it('claims a canvas paste only when it is clearly a registry', () => {
    expect(isRegistryPaste('npx shadcn add button')).toBe(true)
    expect(isRegistryPaste('@magicui/globe')).toBe(true)
    expect(isRegistryPaste('https://magicui.design/r/globe.json')).toBe(true)
    expect(isRegistryPaste('https://magicui.design/docs/components/globe')).toBe(false)
    expect(isRegistryPaste('Buy now')).toBe(false)
  })
})

describe('the registry directory', () => {
  it('lists the official registry and featured ones first, without hidden entries', async () => {
    respond({})
    const entries = await registryDirectory()
    expect(entries.map((entry) => entry.namespace)).toEqual(['@shadcn', '@ace', '@magic', '@styled'])
    expect(entries[0]?.featured).toBe(true)
  })

  it('falls back to the official registry when the directory cannot be read', async () => {
    network.fetch.mockResolvedValue(new Response('down', { status: 503 }))
    expect((await registryDirectory()).map((entry) => entry.namespace)).toEqual(['@shadcn'])
  })
})

describe('previewing whatever was pasted', () => {
  it('previews index metadata without exposing source or fetching unselected items', async () => {
    respond({ [root]: { name: 'Acme', items: [button, card, { name: 'utils', type: 'registry:lib' }] } })
    expect(await previewRegistry(root)).toEqual({
      name: 'Acme',
      namespace: undefined,
      homepage: undefined,
      items: [
        { name: 'button', title: 'button', description: '', type: 'registry:ui', source: root },
        { name: 'card', title: 'card', description: '', type: 'registry:ui', source: root },
      ],
    })
    expect(fetched()).toEqual([root])
  })

  it('opens a namespace’s index through its directory template', async () => {
    respond({ 'https://magic.example/r/registry': { name: 'magic', items: [button] } })
    const preview = await previewRegistry('@magic')
    expect(preview.namespace).toBe('@magic')
    expect(preview.items[0]?.source).toBe('https://magic.example/r/registry')
  })

  it('tries the common styles for a template that names one', async () => {
    respond({ 'https://styled.example/r/new-york/registry.json': { name: 'styled', items: [button] } })
    expect((await previewRegistry('@styled')).items.map((item) => item.name)).toEqual(['button'])
  })

  it('reads an install command naming several items from different registries', async () => {
    respond({
      'https://magic.example/r/marquee': { ...card, name: 'marquee' },
      'https://ui.shadcn.com/r/styles/new-york-v4/button.json': button,
    })
    const preview = await previewRegistry('npx shadcn@latest add @magic/marquee button')
    expect(preview.items.map((item) => [item.name, item.source])).toEqual([
      ['marquee', 'https://magic.example/r/marquee'],
      ['button', 'https://ui.shadcn.com/r/styles/new-york-v4/button.json'],
    ])
  })

  it('finds the install commands on a docs page', async () => {
    respond({
      'https://magic.example/docs/marquee':
        '<pre>npx shadcn@latest add @magic/marquee</pre><pre>pnpm dlx shadcn@latest add @magic/marquee</pre>',
      'https://magic.example/r/marquee': { ...card, name: 'marquee', title: 'Marquee' },
    })
    expect(await previewRegistry('magic.example/docs/marquee')).toMatchObject({
      name: 'Marquee',
      items: [{ name: 'marquee', source: 'https://magic.example/r/marquee' }],
    })
  })

  it('falls back to the site’s registry index when a page shows no command', async () => {
    respond({
      'https://acme.example/': '<h1>Acme UI</h1>',
      'https://acme.example/r/registry.json': { name: 'Acme', items: [button] },
    })
    expect((await previewRegistry('https://acme.example/')).name).toBe('Acme')
  })

  it('says what to paste when nothing is found', async () => {
    respond({ 'https://plain.example/': '<h1>Hello</h1>' })
    await expect(previewRegistry('https://plain.example/')).rejects.toThrow('No shadcn registry found')
    await expect(previewRegistry('@nobody')).rejects.toThrow('not in the public shadcn registry directory')
  })

  it('rejects invalid registries', async () => {
    respond({ [root]: { hello: 'world' } })
    await expect(previewRegistry(root)).rejects.toThrow('Expected a shadcn')
  })
})

describe('resolving an import', () => {
  it('resolves direct item URLs with their theme data and package metadata', async () => {
    respond({ [root]: { ...button, cssVars: { light: { primary: 'red' } }, dependencies: ['@radix-ui/react-slot'] } })
    const result = await prepareRegistryImport(only('button'))
    expect(result.selected[0]?.files?.[0]?.path).toBe('ui/button.tsx')
    expect(result.selected[0]?.dependencies).toEqual(['@radix-ui/react-slot'])
    expect(result.selected[0]?.cssVars).toEqual({ light: { primary: 'red' } })
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
    const result = await prepareRegistryImport(only('button'))
    expect(result.items.map((item) => item.name)).toEqual(['button', 'card'])
    expect(result.selected.map((item) => item.name)).toEqual(['button'])
    expect(fetched()).toEqual([root])
  })

  it('fetches published item JSON when an index contains paths without contents', async () => {
    respond({
      [root]: { name: 'Acme', items: [{ ...button, files: [{ path: 'ui/button.tsx' }] }] },
      'https://registry.example/r/button.json': button,
    })
    expect((await prepareRegistryImport(only('button'))).selected[0]?.files?.[0]?.content).toContain(
      'export const Button',
    )
    expect(fetched()).toHaveLength(2)
  })

  it('reaches an index’s items through the directory template, not beside the index', async () => {
    const index = 'https://ace.example/registry.json'
    respond({
      [index]: { name: 'ace', items: [{ ...card, files: [{ path: 'card.tsx' }] }] },
      'https://ace.example/registry/card.json': card,
    })
    const result = await prepareRegistryImport([{ source: index, name: 'card' }])
    expect(result.selected[0]?.files?.[0]?.content).toContain('Card')
  })

  it('resolves public URL, namespaced and standard shadcn dependencies', async () => {
    respond({
      [root]: {
        ...button,
        registryDependencies: ['https://other.example/card.json', 'input', '@magic/marquee'],
      },
      'https://other.example/card.json': card,
      'https://ui.shadcn.com/r/styles/new-york-v4/input.json': { ...card, name: 'input' },
      'https://magic.example/r/marquee': { ...card, name: 'marquee' },
    })
    expect((await prepareRegistryImport(only('button'))).items.map((item) => item.name)).toEqual([
      'button',
      'card',
      'input',
      'marquee',
    ])
  })

  it('brings in the shadcn primitives an item imports without listing them', async () => {
    respond({
      [root]: {
        ...button,
        name: 'demo',
        files: [
          { path: 'demo.tsx', content: `import { Card } from "@/components/ui/card"\nexport default () => <Card />` },
        ],
      },
      'https://ui.shadcn.com/r/styles/new-york-v4/card.json': {
        ...card,
        files: [{ path: 'ui/card.tsx', content: 'x' }],
      },
    })
    expect((await prepareRegistryImport(only('demo'))).items.map((item) => item.name)).toEqual(['demo', 'card'])
  })

  it('keeps dependencies in the selected official style instead of mixing Nova and New York', async () => {
    const nova = 'https://ui.shadcn.com/r/styles/radix-nova/'
    respond({
      [nova + 'demo.json']: { ...button, name: 'demo', registryDependencies: ['card'] },
      [nova + 'card.json']: card,
    })
    const result = await prepareRegistryImport([{ source: nova + 'demo.json', name: 'demo' }])
    expect(result.items.map((item) => item.name)).toEqual(['demo', 'card'])
    expect(fetched().at(-1)).toBe(nova + 'card.json')
  })

  it('rejects missing selections and unresolved namespaces', async () => {
    respond({ [root]: { name: 'Acme', items: [button] } })
    await expect(prepareRegistryImport(only('gone'))).rejects.toThrow('no longer available')
    await expect(prepareRegistryImport([])).rejects.toThrow('Select between')
    await expect(prepareRegistryImport(only('button', 'button'))).rejects.toThrow('distinct')
    respond({ [root]: { ...button, registryDependencies: ['@private/card'] } })
    await expect(prepareRegistryImport(only('button'))).rejects.toThrow('not in the public shadcn registry directory')
  })

  it('blocks private URLs and private redirect targets before fetching them', async () => {
    await expect(previewRegistry('http://127.0.0.1/registry.json')).rejects.toThrow()
    expect(fetched()).toEqual([])
    respond({ [root]: new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/internal' } }) })
    await expect(previewRegistry(root)).rejects.toThrow()
    expect(fetched()).toEqual([root])
  })

  it('limits downloaded bytes and source size', async () => {
    respond({ [root]: new Response('huge', { headers: { 'content-length': '8000001' } }) })
    await expect(previewRegistry(root)).rejects.toThrow('too large')
    respond({ [root]: { ...button, files: [{ path: 'big.tsx', content: 'x'.repeat(50_000) }] } })
    expect((await prepareRegistryImport(only('button'))).selected[0]?.files?.[0]?.content?.length).toBe(50_000)
    respond({ [root]: { ...button, files: [{ path: 'huge.tsx', content: 'x'.repeat(160_000) }] } })
    await expect(prepareRegistryImport(only('button'))).rejects.toThrow('too large')
  })
})
