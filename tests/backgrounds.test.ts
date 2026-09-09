import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import {
  fetchThumb,
  keyForFile,
  normalizeTags,
  searchBackgrounds,
  setCatalogForTests,
  type BackgroundEntry,
} from '../server/backgrounds.ts'
import { buildMcpServer } from '../server/mcp.ts'

const entry = (over: Partial<BackgroundEntry> & Pick<BackgroundEntry, 'id'>): BackgroundEntry => ({
  source: over.id,
  enabled: true,
  created_at: 0,
  width: 1600,
  height: 1000,
  tone: 'dark',
  style: 'glow',
  avg_color: '#101018',
  palette: ['#101018', '#7c3aed'],
  tags: ['purple', 'calm', 'saas'],
  slots: ['hero', 'section'],
  text_zone: 'left',
  description: 'Soft purple glow on a near-black field',
  ...over,
})

const CATALOG: BackgroundEntry[] = [
  entry({ id: 'purpleglow' }),
  entry({
    id: 'sunset',
    tone: 'light',
    style: 'landscape',
    tags: ['warm', 'sunset', 'orange', 'coast'],
    slots: ['hero'],
    text_zone: 'top',
    description: 'Warm sunset over a quiet coastline with pale sky',
  }),
  entry({
    id: 'tealaurora',
    style: 'aurora',
    tags: ['teal', 'cool', 'tech', 'calm'],
    slots: ['hero', 'section', 'card'],
    text_zone: 'right',
    description: 'Teal aurora ribbon drifting across black',
  }),
  entry({
    id: 'pastelmesh',
    tone: 'light',
    style: 'mesh',
    tags: ['pastel', 'pink', 'soft', 'wellness'],
    slots: ['section', 'card'],
    text_zone: 'anywhere',
    description: 'Pastel pink and lavender mesh blur',
  }),
]

const ORIGIN = 'https://doop.test'

describe('searchBackgrounds', () => {
  afterEach(() => setCatalogForTests([]))

  it('ranks by query words across tags, style and description', () => {
    setCatalogForTests(CATALOG)
    expect(searchBackgrounds('warm sunset', {}, ORIGIN)[0]?.id).toBe('sunset')
  })

  it('reads tone, style and slot out of the query when no filter is passed', () => {
    setCatalogForTests(CATALOG)
    const ids = searchBackgrounds('dark aurora hero', {}, ORIGIN).map((r) => r.id)
    expect(ids).toEqual(['tealaurora'])
  })

  it('applies explicit filters over query hints', () => {
    setCatalogForTests(CATALOG)
    const ids = searchBackgrounds('calm', { tone: 'light', slot: 'card' }, ORIGIN).map((r) => r.id)
    expect(ids).toEqual(['pastelmesh'])
  })

  it('returns a spread of styles for a filter-only query', () => {
    setCatalogForTests(CATALOG)
    const styles = searchBackgrounds('', { tone: 'dark' }, ORIGIN).map((r) => r.style)
    expect(new Set(styles).size).toBe(styles.length)
  })

  it('builds urls on the public origin and a scrim that fades toward the text zone', () => {
    setCatalogForTests(CATALOG)
    const r = searchBackgrounds('purple', {}, ORIGIN)[0]!
    expect(r.image_url).toBe(`${ORIGIN}/bg/purpleglow.webp`)
    expect(r.thumb_url).toBe(`${ORIGIN}/bg/purpleglow-t.webp`)
    expect(r.css).toContain('to right')
    expect(r.css).toContain('rgba(0,0,0,.45)')
    expect(r.css).toContain(r.image_url)
  })

  it('never returns a disabled background', () => {
    setCatalogForTests([...CATALOG, entry({ id: 'hidden', tags: ['zebra'], enabled: false })])
    expect(searchBackgrounds('zebra', {}, ORIGIN)).toEqual([])
  })

  it('caps count at 8 and returns nothing for words that match nothing', () => {
    setCatalogForTests(CATALOG)
    expect(searchBackgrounds('', { count: 50 }, ORIGIN).length).toBeLessThanOrEqual(8)
    expect(searchBackgrounds('zebra', {}, ORIGIN)).toEqual([])
  })
})

describe('/bg key mapping', () => {
  it('accepts display and thumb names only', () => {
    expect(keyForFile('abc123.webp')).toBe('bg/abc123.webp')
    expect(keyForFile('abc123-t.webp')).toBe('bg/abc123-t.webp')
    expect(keyForFile('../x.webp')).toBeNull()
    expect(keyForFile('abc.png')).toBeNull()
  })
})

describe('search_backgrounds MCP tool', () => {
  afterEach(() => setCatalogForTests([]))

  it('is registered, filters by enum, and returns css with the results', async () => {
    setCatalogForTests(CATALOG)
    const server = buildMcpServer('Test Owner', 'test-owner-id')
    const client = new Client({ name: 'doop-backgrounds-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const { tools } = await client.listTools()
      const tool = tools.find((t) => t.name === 'search_backgrounds')
      expect(tool).toBeDefined()
      const schema = tool!.inputSchema as { properties?: Record<string, { enum?: string[] }> }
      expect(schema.properties?.tone?.enum).toEqual(['light', 'dark'])
      expect(schema.properties?.slot?.enum).toEqual(['hero', 'section', 'card'])
      expect(client.getInstructions()).toContain('search_backgrounds')

      const result = await client.callTool({
        name: 'search_backgrounds',
        arguments: { query: 'teal', agent_name: 'tester' },
      })
      const texts = (result.content as { type: string; text?: string }[])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n')
      expect(texts).toContain('#1 — Teal aurora ribbon')
      expect(texts).toContain('image_url: http://localhost:4300/bg/tealaurora.webp')
      expect(texts).toContain('css: background: linear-gradient(')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('tells the agent to draw CSS when the library is empty', async () => {
    setCatalogForTests([])
    const server = buildMcpServer('Test Owner', 'test-owner-id')
    const client = new Client({ name: 'doop-backgrounds-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const result = await client.callTool({
        name: 'search_backgrounds',
        arguments: { query: 'anything', agent_name: 'tester' },
      })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('library is empty')
    } finally {
      await client.close()
      await server.close()
    }
  })
})

describe('normalizeTags', () => {
  it('accepts comma-separated words and lowercases them', () => {
    const tags = normalizeTags({
      tone: 'dark',
      style: 'glow',
      palette: '#101018, #7C3AED',
      tags: 'Purple, calm  saas',
      slots: ['hero', 'hero', 'card'],
      text_zone: 'left',
      description: ' Soft purple glow ',
    })
    expect(tags.palette).toEqual(['#101018', '#7c3aed'])
    expect(tags.tags).toEqual(['purple', 'calm', 'saas'])
    expect(tags.slots).toEqual(['hero', 'card'])
    expect(tags.description).toBe('Soft purple glow')
  })

  it('rejects values outside the vocabularies', () => {
    const base = { tone: 'dark', style: 'glow', palette: ['#000000'], slots: ['hero'], text_zone: 'left' }
    expect(() => normalizeTags({ ...base, tone: 'dim' })).toThrow('tone')
    expect(() => normalizeTags({ ...base, style: 'sparkly' })).toThrow('style')
    expect(() => normalizeTags({ ...base, slots: [] })).toThrow('slots')
    expect(() => normalizeTags({ ...base, palette: ['red'] })).toThrow('palette')
  })
})

describe('fetchThumb', () => {
  const originalOrigin = process.env.BACKGROUNDS_ORIGIN
  const originalFetch = globalThis.fetch
  afterEach(() => {
    if (originalOrigin === undefined) delete process.env.BACKGROUNDS_ORIGIN
    else process.env.BACKGROUNDS_ORIGIN = originalOrigin
    globalThis.fetch = originalFetch
  })

  it('reads thumbnails over HTTP from BACKGROUNDS_ORIGIN when set', async () => {
    process.env.BACKGROUNDS_ORIGIN = 'https://doop.example/'
    const seen: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen.push(String(input))
      return new Response(Buffer.from('webp-bytes'), { status: 200 })
    }) as typeof fetch
    const thumb = await fetchThumb('abc')
    expect(seen).toEqual(['https://doop.example/bg/abc-t.webp'])
    expect(thumb).toEqual({ data: Buffer.from('webp-bytes').toString('base64'), mime: 'image/webp' })
  })

  it('returns null rather than throwing when the remote origin fails', async () => {
    process.env.BACKGROUNDS_ORIGIN = 'https://doop.example'
    globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch
    expect(await fetchThumb('abc')).toBeNull()
  })
})
