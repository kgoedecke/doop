import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * A Storybook import through MCP, from the CLI's captures: no browser, the real build, the real
 * component and token writes, the sync bookkeeping. The source table, fonts and assets are played
 * by the test (tests/storybookImportHttp.test.ts covers the table on a real database).
 */

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  refreshAssetRefs: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
  saveToken: () => {},
  deleteToken: () => {},
}))

const sources = vi.hoisted(() => new Map<string, Record<string, unknown>>())
vi.mock('../server/storybook/sources.ts', () => {
  type Source = { id: string; canvasId: string; url: string; components: { title: string }[]; tokens: string[] }
  const all = () => [...sources.values()] as unknown as Source[]
  return {
    publicView: ({ tokens: _tokens, ...rest }: Source) => rest,
    sourcesOf: async (canvasId: string) => all().filter((s) => s.canvasId === canvasId),
    sourceById: async (canvasId: string, id: string) =>
      all().find((s) => s.canvasId === canvasId && s.id === id) ?? null,
    sourceByUrl: async (canvasId: string, url: string) =>
      all().find((s) => s.canvasId === canvasId && s.url === url) ?? null,
    upsertSource: async (canvasId: string, url: string, picked: { title: string }[]) => {
      const found = all().find((s) => s.canvasId === canvasId && s.url === url)
      if (found) {
        const known = new Map(found.components.map((c) => [c.title, c]))
        for (const pick of picked) known.set(pick.title, { ...known.get(pick.title), ...pick })
        found.components = [...known.values()]
        return found
      }
      const source = {
        id: `src${sources.size}`,
        canvasId,
        url,
        components: picked,
        tokens: [],
        lastResult: null,
        createdAt: 1,
        syncedAt: null,
      }
      sources.set(source.id, source)
      return source
    },
    recordRun: async (
      id: string,
      { result, ...update }: { components?: unknown[]; tokens?: string[]; result?: unknown },
    ) => {
      Object.assign(sources.get(id)!, update, result ? { lastResult: result } : {})
    },
    deleteSource: async () => true,
  }
})

const assetUpload = vi.hoisted(() => vi.fn(async () => ({ id: 'pic1', ext: 'png', mime: 'image/png', size: 3 })))
const fonts = vi.hoisted(() => ({ added: [] as string[] }))
vi.mock('../server/canvasFontUpload.ts', () => ({
  addCanvasFont: async (_canvasId: string, _user: unknown, buf: Buffer, fileName: string) => {
    fonts.added.push(`${fileName}:${buf.length}`)
    /* the file says its family is "Brand Sans", the stylesheet named it "Brand Sans Variable" */
    return { family: 'Brand Sans', weight: '400', style: 'normal' }
  },
}))
vi.mock('../server/assets.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/assets.ts')>()),
  createAsset: assetUpload,
}))

import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import * as propagation from '../server/propagation.ts'
import { findComponent } from '../server/componentActions.ts'
import type { ComponentCapture } from '../shared/storybookAcquire.ts'

let OWNER = ''
let client: Client

type ToolResponse = { content: { type: string; text?: string }[]; isError?: boolean }
async function call(
  name: string,
  args: Record<string, unknown>,
  // eslint-disable-next-line typescript/no-explicit-any
): Promise<{ data: any; text: string; isError: boolean }> {
  const response = (await client.callTool({ name, arguments: { agent_name: 'Tester', ...args } })) as ToolResponse
  await propagation.whenIdle()
  const texts = response.content.flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
  let data: unknown
  try {
    data = JSON.parse(texts[0] ?? '')
  } catch {
    data = undefined
  }
  return { data, text: texts.join('\n'), isError: !!response.isError }
}

const FACE = `@font-face { font-family: "Brand Sans Variable"; src: url("data:font/woff2;base64,AAAA") format("woff2"); }`
const RULES = [
  '.btn { display: inline-flex; padding: 8px 14px; font-family: "Brand Sans Variable", sans-serif; }',
  '.bg-primary { background-color: var(--primary); color: var(--primary-foreground); }',
  '.border { border: 1px solid var(--border); }',
  '.icon { background-image: url("data:image/png;base64,iVBORw0KGgo="); }',
  '.dark .btn { outline: 1px solid var(--border); }',
]

function capture(primary = 'oklch(0.2 0 0)'): ComponentCapture {
  const story = (classes: string) => ({
    html: `<button class="btn ${classes}"><i class="icon"></i><span>Save</span></button>`,
    rules: RULES,
    vars: { '--primary': primary, '--primary-foreground': '#fff', '--border': '#e5e5e5' },
    fontFaces: [FACE],
    text: { 'font-family': '"Brand Sans Variable", sans-serif' },
    width: 90,
    height: 36,
    warnings: [],
  })
  return {
    title: 'UI/Button',
    name: 'Button',
    storyId: 'ui-button--default',
    codePath: 'src/ui/button.tsx',
    props: [
      {
        name: 'variant',
        arg: 'variant',
        kind: 'enum',
        options: ['default', 'outline'],
        values: ['default', 'outline'],
        default: 'default',
      },
    ],
    texts: [{ name: 'children', arg: 'children', value: 'Save' }],
    base: story('bg-primary'),
    variants: [{ prop: 'variant', value: 'outline', capture: story('border') }],
    darkVars: { '--primary': 'oklch(0.9 0 0)' },
    warnings: [],
  }
}

beforeEach(async () => {
  OWNER = crypto.randomUUID()
  for (const c of store.allCanvases()) store.canvases.delete(c.id)
  sources.clear()
  fonts.added = []
  assetUpload.mockClear()
  const server = buildMcpServer('Owner', OWNER)
  client = new Client({ name: 'storybook-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
})

afterEach(async () => {
  await client.close()
})

describe('importing a Storybook from captures', () => {
  it('lands the component with its variants, text prop, code, tokens, fonts and pictures', async () => {
    const canvas = store.createCanvas('Kit', OWNER)
    const imported = await call('import_storybook', {
      canvas_id: canvas.id,
      url: 'http://localhost:6006/?path=/story/ui-button--default',
      captures: [capture()],
    })
    expect(imported.isError).toBe(false)
    expect(imported.data.state).toBe('done')
    expect(imported.data.summary).toContain('1 created')
    const [result] = imported.data.result.components
    expect(result).toMatchObject({ title: 'UI/Button', outcome: 'created' })

    const def = findComponent(canvas.id, 'Button')!
    expect(def.props.map((p) => [p.name, p.type])).toEqual([
      ['variant', 'enum'],
      ['children', 'text'],
    ])
    expect(def.code).toMatchObject({ path: 'src/ui/button.tsx', name: 'Button' })
    expect(def.rawCss).toContain('[data-variant="outline"]')
    /* the font's family as the library knows it, the picture from the asset store */
    expect(def.rawCss).toContain('"Brand Sans"')
    expect(def.rawCss).not.toContain('Brand Sans Variable')
    expect(def.rawCss).toContain('/a/pic1.png')
    expect(def.rawCss).not.toContain('base64')
    expect(def.rawCss).toContain('[data-doop-theme="dark"]')
    expect(fonts.added).toEqual(['Brand Sans Variable.woff2:3'])

    const tokens = new Map(store.getTokens(canvas.id).map((t) => [t.name, t]))
    expect(tokens.get('--primary')).toMatchObject({
      type: 'color',
      value: 'oklch(0.2 0 0)',
      themes: { dark: 'oklch(0.9 0 0)' },
    })
    expect(tokens.get('--border')?.value).toBe('#e5e5e5')

    const source = [...sources.values()][0]!
    expect(source.url).toBe('http://localhost:6006/')
    expect(source.tokens).toEqual(expect.arrayContaining(['--primary', '--border']))
  })

  it('syncs: unchanged is left alone, a changed theme updates its tokens and the component', async () => {
    const canvas = store.createCanvas('Kit', OWNER)
    const url = 'http://localhost:6006/'
    await call('import_storybook', { canvas_id: canvas.id, url, captures: [capture()] })
    const rev = findComponent(canvas.id, 'Button')!.rev

    const again = await call('import_storybook', { canvas_id: canvas.id, url, captures: [capture()] })
    expect(again.data.result.components[0].outcome).toBe('unchanged')
    expect(fonts.added).toHaveLength(1)
    expect(assetUpload).toHaveBeenCalledTimes(1)
    expect(findComponent(canvas.id, 'Button')!.rev).toBe(rev)

    /* a new brand colour is a token change: the component reads var(--primary) and is not touched */
    const recoloured = await call('import_storybook', {
      canvas_id: canvas.id,
      url,
      captures: [capture('oklch(0.4 0.1 250)')],
    })
    expect(recoloured.data.result.components[0].outcome).toBe('unchanged')
    expect(recoloured.data.result.tokens.updated).toEqual(['--primary'])
    expect(store.getTokens(canvas.id).find((t) => t.name === '--primary')?.value).toBe('oklch(0.4 0.1 250)')

    /* new padding in code is a new revision of the component, which its instances follow */
    const padded = capture('oklch(0.4 0.1 250)')
    padded.base.rules = padded.base.rules.map((rule) => rule.replace('8px 14px', '10px 16px'))
    const changed = await call('import_storybook', { canvas_id: canvas.id, url, captures: [padded] })
    expect(changed.data.result.components[0].outcome).toBe('updated')
    expect(findComponent(canvas.id, 'Button')!.rawCss).toContain('10px 16px')
    expect(findComponent(canvas.id, 'Button')!.rev).toBeGreaterThan(rev)
  })

  it('leaves a component and tokens it did not make alone, and says so', async () => {
    const canvas = store.createCanvas('Kit', OWNER)
    await call('create_tokens', {
      canvas_id: canvas.id,
      tokens: [{ name: '--primary', type: 'color', value: '#ff0000' }],
    })
    await call('create_component', { canvas_id: canvas.id, name: 'Button', html: '<button class="mine">Mine</button>' })
    const imported = await call('import_storybook', {
      canvas_id: canvas.id,
      url: 'http://localhost:6006/',
      captures: [capture()],
    })
    expect(imported.data.result.components[0].outcome).toBe('skipped')
    expect(imported.data.result.components[0].notes.join(' ')).toContain('already has a component named “Button”')
    expect(imported.data.result.tokens.leftAlone).toEqual(['--primary'])
    expect(store.getTokens(canvas.id).find((t) => t.name === '--primary')?.value).toBe('#ff0000')
    expect(findComponent(canvas.id, 'Button')!.template).toContain('Mine')
  })

  it('refuses captures that are not captures, and asks for titles without them', async () => {
    const canvas = store.createCanvas('Kit', OWNER)
    const bad = await call('import_storybook', {
      canvas_id: canvas.id,
      url: 'http://localhost:6006/',
      captures: [{ title: 'x' }],
    })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('a capture needs title and name')
    const none = await call('import_storybook', { canvas_id: canvas.id, url: 'https://sb.example.com/' })
    expect(none.isError).toBe(true)
    expect(none.text).toContain('pass components')
  })

  it('syncs what a canvas imports from, by itself', async () => {
    const canvas = store.createCanvas('Kit', OWNER)
    const nothing = await call('sync_storybook', { canvas_id: canvas.id })
    expect(nothing.text).toContain('imports from no Storybook yet')
  })
})
