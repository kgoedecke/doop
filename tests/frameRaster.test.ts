// @vitest-environment happy-dom
// @vitest-environment-options { "happyDOM": { "settings": { "disableCSSFileLoading": true } } }
import { afterEach, expect, it, vi } from 'vitest'
import * as css from 'css-tree'
import { clipToFrame, inlineDocument } from '../src/lib/frameRaster'
import { PrivateExportOperation } from '../src/lib/privateExport'
import { fixturePrivateMaterializer } from './privateMediaAdapter'

// Observe construction while retaining the real CSS encoder and AST parser.
vi.mock('css-tree', async (original) => {
  const actual = await original<typeof import('css-tree')>()
  return { ...actual, string: { ...actual.string, encode: vi.fn(actual.string.encode) } }
})

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
const PNG_DATA = 'data:image/png;base64,iVBORw=='

/** a fetch that serves `routes` by absolute URL and 404s the rest */
function serve(routes: Record<string, { body: BodyInit; type: string }>) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input)
      calls.push(url)
      const hit = routes[url]
      if (!hit) return new Response('missing', { status: 404 })
      return new Response(hit.body, { headers: { 'content-type': hit.type } })
    }),
  )
  return calls
}

const operations: PrivateExportOperation[] = []
const opts = () => {
  const operation = new PrivateExportOperation(
    { id: 'fixture-frame', canvasId: 'fixture-canvas' },
    undefined,
    fixturePrivateMaterializer,
  )
  operations.push(operation)
  return { width: 300, height: 200, signal: operation.signal, operation }
}

afterEach(() => {
  for (const operation of operations.splice(0)) operation.close()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

it('wraps the document in a frame-sized SVG with scripts removed', async () => {
  serve({})
  const svg = await inlineDocument(
    '<!doctype html><html><head><script>alert(1)</script></head><body><h1>Hi</h1></body></html>',
    opts(),
  )
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">')).toBe(true)
  expect(svg).toContain('<foreignObject width="300" height="200">')
  expect(svg).toContain('<html xmlns="http://www.w3.org/1999/xhtml">')
  expect(svg).toContain('<h1>Hi</h1>')
  expect(svg).not.toContain('<script')
})

it('rejects a document that embeds another, so the server renders it whole', async () => {
  serve({})
  for (const embed of ['<iframe src="/x"></iframe>', '<object data="/x.svg"></object>', '<embed src="/x.pdf">']) {
    await expect(inlineDocument(`<html><body><h1>Hi</h1>${embed}</body></html>`, opts())).rejects.toThrow(
      'embeds a document',
    )
  }
})

it('inlines images, stylesheets and the fonts they name as data: URLs', async () => {
  const calls = serve({
    'http://localhost:3000/public/pic.png': { body: PNG, type: 'image/png' },
    'https://fonts.example/css': { body: '@font-face{font-family:F;src:url(/f.woff2)}', type: 'text/css' },
    'https://fonts.example/f.woff2': { body: PNG, type: 'font/woff2' },
    'http://localhost:3000/public/bg.png': { body: PNG, type: 'image/png' },
  })
  const svg = await inlineDocument(
    `<html><head><link rel="stylesheet" href="https://fonts.example/css"><style>.hero{background:url("/public/bg.png")}</style></head>` +
      `<body><img src="/public/pic.png" srcset="/public/pic@2x.png 2x" loading="lazy" style="background-image:url(/public/bg.png)"></body></html>`,
    opts(),
  )
  expect(svg).toContain(`src="${PNG_DATA}"`)
  expect(svg).not.toContain('srcset')
  expect(svg).not.toContain('loading=')
  expect(svg).not.toContain('<link')
  expect(svg).toContain('font-family:F;src:url("data:font/woff2;base64,')
  expect(svg).toContain(`.hero{background:url("${PNG_DATA}")}`)
  expect(svg).toContain(`style="background-image:url(&quot;${PNG_DATA}&quot;)"`)
  /* one fetch per URL, however many places name it */
  expect(calls.filter((url) => url.endsWith('/public/bg.png'))).toHaveLength(1)
  expect(calls).not.toContain('http://localhost:3000/public/pic@2x.png')
})

it('leaves data: and fragment references alone', async () => {
  const calls = serve({})
  const svg = await inlineDocument(
    `<html><body><img src="${PNG_DATA}"><svg><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/></svg></body></html>`,
    opts(),
  )
  expect(calls).toHaveLength(0)
  expect(svg).toContain(`src="${PNG_DATA}"`)
  expect(svg).toContain('fill="url(#g)"')
})

it('keeps the fragment that picks an SVG view, in markup and in CSS', async () => {
  const calls = serve({ 'https://cdn.example/sprite.svg': { body: '<svg/>', type: 'image/svg+xml' } })
  const svg = await inlineDocument(
    '<html><head><style>.i{background:url(https://cdn.example/sprite.svg#icon)}</style></head>' +
      '<body><img src="https://cdn.example/sprite.svg#svgView(viewBox(0,0,10,10))"></body></html>',
    opts(),
  )
  expect(calls).toEqual(['https://cdn.example/sprite.svg'])
  expect(svg).toMatch(/src="data:image\/svg\+xml;base64,[^"]+#svgView\(viewBox\(0,0,10,10\)\)"/)
  expect(svg).toMatch(/url\("data:image\/svg\+xml;base64,[^"]+#icon"\)/)
})

it('rejects an image at an object URL it cannot read, for the server to render', async () => {
  serve({})
  await expect(
    inlineDocument('<html><body><img src="blob:https://doop.design/0c1d"></body></html>', opts()),
  ).rejects.toThrow()
})

it('resolves relative URLs against the document base', async () => {
  const calls = serve({ 'https://cdn.example/site/img/a.png': { body: PNG, type: 'image/png' } })
  await inlineDocument(
    '<html><head><base href="https://cdn.example/site/"></head><body><img src="img/a.png"></body></html>',
    opts(),
  )
  expect(calls).toEqual(['https://cdn.example/site/img/a.png'])
})

it("inlines string-form imports and keeps a stylesheet link's media condition", async () => {
  serve({
    'https://cdn.example/print.css': { body: '@import "theme.css"; p{color:red}', type: 'text/css' },
    'https://cdn.example/theme.css': { body: 'b{color:blue}', type: 'text/css' },
  })
  const svg = await inlineDocument(
    '<html><head><link rel="stylesheet" href="https://cdn.example/print.css" media="print"></head><body></body></html>',
    opts(),
  )
  expect(svg).toContain('<style media="print">@import "data:text/css;base64,')
  expect(svg).not.toContain('@import "theme.css"')
  expect(svg).toContain('p{color:red}')
  expect(atob(/data:text\/css;base64,([A-Za-z0-9+/=]+)/.exec(svg)![1]!)).toBe('b{color:blue}')
})

it('ends an import cycle where it started instead of spinning', async () => {
  const calls = serve({
    'https://cdn.example/a.css': { body: '@import url(b.css); a{}', type: 'text/css' },
    'https://cdn.example/b.css': { body: '@import url(a.css); b{}', type: 'text/css' },
  })
  const svg = await inlineDocument(
    '<html><head><style>@import url("https://cdn.example/a.css");</style></head><body></body></html>',
    opts(),
  )
  expect(svg).toContain('@import url("data:text/css;base64,')
  expect(calls.filter((url) => url.endsWith('a.css'))).toHaveLength(1)
})

it('rejects when a resource cannot be fetched, so the server renders instead', async () => {
  serve({})
  await expect(
    inlineDocument('<html><body><img src="https://private.example/no-cors.png"></body></html>', opts()),
  ).rejects.toThrow('404 fetching https://private.example/no-cors.png')
})

/* an element export keeps the part of the whole render its box covers */
it('clips an element box to whole frame pixels inside the frame', () => {
  const frame = { width: 300, height: 200 }
  expect(clipToFrame({ x: 10.4, y: 20.6, width: 50.2, height: 30 }, frame)).toEqual({
    x: 10,
    y: 20,
    width: 51,
    height: 31,
  })
  /* a box past the frame's edge is cut where the frame cuts it */
  expect(clipToFrame({ x: 280, y: -10, width: 50, height: 30 }, frame)).toEqual({ x: 280, y: 0, width: 20, height: 20 })
  /* a box the frame does not show cannot be exported from it */
  expect(clipToFrame({ x: 300, y: 0, width: 10, height: 10 }, frame)).toBeNull()
  expect(clipToFrame({ x: 0, y: 0, width: 0, height: 10 }, frame)).toBeNull()
})

it('inlines SVG presentation URLs through the same AST owner without changing local fragments', async () => {
  const calls = serve({ 'https://cdn.example/texture.png': { body: PNG, type: 'image/png' } })
  const svg = await inlineDocument(
    '<svg><rect fill="url(https://cdn.example/texture.png)" filter="url(#shadow)"/></svg>',
    opts(),
  )
  expect(svg).toContain(`fill="url(&quot;${PNG_DATA}&quot;)"`)
  expect(svg).toContain('filter="url(#shadow)"')
  expect(calls).toEqual(['https://cdn.example/texture.png'])
})

it('repeated resources share one byte admission while every insertion counts toward expanded output', async () => {
  const calls = serve({ 'https://cdn.example/repeated.png': { body: PNG, type: 'image/png' } })
  const options = opts()
  const svg = await inlineDocument('<img src="https://cdn.example/repeated.png">'.repeat(12), options)
  expect(svg.split(PNG_DATA)).toHaveLength(13)
  expect(calls).toEqual(['https://cdn.example/repeated.png'])
  expect(options.operation.budget.usage.encodedBytes).toBe(PNG.length)
  expect(options.operation.budget.usage.expandedBytes).toBeGreaterThan(new TextEncoder().encode(svg).length)
})

it.each(['style element', 'style attribute', 'nested import'])(
  'rejects repeated CSS expansion before constructing it in a %s',
  async (carrier) => {
    const options = opts()
    const bytes = new Uint8Array(800)
    bytes.set(PNG)
    const declarations = Array.from(
      { length: 4 },
      (_, index) => `--image-${index}:url(https://cdn.example/repeated.png);`,
    ).join('')
    const rules = `.images{${declarations}}`
    const html =
      carrier === 'style attribute'
        ? `<div style="${declarations}"></div>`
        : `<style>${carrier === 'nested import' ? '@import "https://cdn.example/root.css";' : rules}</style>`
    const encode = vi.mocked(css.string.encode)
    const admit = options.operation.publicResource.bind(options.operation)
    vi.spyOn(options.operation, 'publicResource').mockImplementation(async (...args) => {
      const value = await admit(...args)
      // The value wrapper legitimately encodes its one input for admission.
      // Observe only subsequent CSS insertions, after that admission finishes.
      encode.mockClear()
      return value
    })
    const fetch = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/root.css'))
        return new Response('@import "child.css";', { headers: { 'content-type': 'text/css' } })
      if (url.endsWith('/child.css')) return new Response(rules, { headers: { 'content-type': 'text/css' } })
      expect(url).toBe('https://cdn.example/repeated.png')
      // Exercise the real remaining budget after source preparation. The
      // signature-only fixture admits this one resource; no decoder is involved.
      options.operation.budget.chargeExpanded(options.operation.budget.remaining.expandedBytes - 3000)
      return new Response(bytes, { headers: { 'content-type': 'image/png' } })
    })
    vi.stubGlobal('fetch', fetch)

    await expect(inlineDocument(html, options)).rejects.toThrow('exceeds the private media budget')
    expect(fetch.mock.calls.filter(([input]) => String(input).endsWith('/repeated.png'))).toHaveLength(1)
    // The AST rewriter constructs each replacement with this real CSS encoder.
    // A later DOM/serialization rejection would already have encoded these URLs.
    expect(encode.mock.calls.filter(([value]) => value.startsWith('data:image/png'))).toHaveLength(0)
  },
)

it('fits repeated CSS insertions while fetching and admitting their shared resource once', async () => {
  const calls = serve({ 'https://cdn.example/repeated.png': { body: PNG, type: 'image/png' } })
  const options = opts()
  const rules = Array.from(
    { length: 4 },
    (_, index) => `.image-${index}{background:url(https://cdn.example/repeated.png)}`,
  ).join('')
  const svg = await inlineDocument(`<style>${rules}</style>`, options)
  expect(svg.split(PNG_DATA)).toHaveLength(5)
  expect(calls).toEqual(['https://cdn.example/repeated.png'])
  expect(options.operation.budget.usage.encodedBytes).toBe(PNG.length)
})

it('rejects unhandled visual carriers and srcset-only images instead of silently painting blanks', async () => {
  const calls = serve({})
  for (const source of [
    '<img srcset="https://cdn.example/pic.png 1x">',
    '<svg><use href="https://cdn.example/symbol.svg#icon"/></svg>',
    '<svg><filter><feImage href="https://cdn.example/pic.png"/></filter></svg>',
    '<body background="https://cdn.example/pic.png">Content</body>',
  ])
    await expect(inlineDocument(source, opts())).rejects.toThrow(
      'the local renderer cannot inline this visual resource',
    )
  expect(calls).toEqual([])
})
