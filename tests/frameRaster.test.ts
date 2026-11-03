// @vitest-environment happy-dom
// @vitest-environment-options { "happyDOM": { "settings": { "disableCSSFileLoading": true } } }
import { afterEach, expect, it, vi } from 'vitest'
import { inlineDocument } from '../src/lib/frameRaster'

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

const opts = () => ({ width: 300, height: 200, signal: new AbortController().signal })

afterEach(() => vi.unstubAllGlobals())

it('wraps the document in a frame-sized SVG with scripts and nested documents removed', async () => {
  serve({})
  const svg = await inlineDocument(
    '<!doctype html><html><head><script>alert(1)</script></head><body><h1>Hi</h1><iframe src="/x"></iframe></body></html>',
    opts(),
  )
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">')).toBe(true)
  expect(svg).toContain('<foreignObject width="300" height="200">')
  expect(svg).toContain('<html xmlns="http://www.w3.org/1999/xhtml">')
  expect(svg).toContain('<h1>Hi</h1>')
  expect(svg).not.toContain('<script')
  expect(svg).not.toContain('<iframe')
})

it('inlines images, stylesheets and the fonts they name as data: URLs', async () => {
  const calls = serve({
    'http://localhost:3000/a/pic.png': { body: PNG, type: 'image/png' },
    'https://fonts.example/css': { body: '@font-face{font-family:F;src:url(/f.woff2)}', type: 'text/css' },
    'https://fonts.example/f.woff2': { body: PNG, type: 'font/woff2' },
    'http://localhost:3000/a/bg.png': { body: PNG, type: 'image/png' },
  })
  const svg = await inlineDocument(
    `<html><head><link rel="stylesheet" href="https://fonts.example/css"><style>.hero{background:url("/a/bg.png")}</style></head>` +
      `<body><img src="/a/pic.png" srcset="/a/pic@2x.png 2x" loading="lazy" style="background-image:url(/a/bg.png)"></body></html>`,
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
  expect(calls.filter((url) => url.endsWith('/a/bg.png'))).toHaveLength(1)
  expect(calls).not.toContain('http://localhost:3000/a/pic@2x.png')
})

it('leaves data:, blob: and fragment references alone', async () => {
  const calls = serve({})
  const svg = await inlineDocument(
    `<html><body><img src="${PNG_DATA}"><svg><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/></svg></body></html>`,
    opts(),
  )
  expect(calls).toHaveLength(0)
  expect(svg).toContain(`src="${PNG_DATA}"`)
  expect(svg).toContain('fill="url(#g)"')
})

it('resolves relative URLs against the document base', async () => {
  const calls = serve({ 'https://cdn.example/site/img/a.png': { body: PNG, type: 'image/png' } })
  await inlineDocument(
    '<html><head><base href="https://cdn.example/site/"></head><body><img src="img/a.png"></body></html>',
    opts(),
  )
  expect(calls).toEqual(['https://cdn.example/site/img/a.png'])
})

it('rejects when a resource cannot be fetched, so the server renders instead', async () => {
  serve({})
  await expect(
    inlineDocument('<html><body><img src="https://private.example/no-cors.png"></body></html>', opts()),
  ).rejects.toThrow('404 fetching https://private.example/no-cors.png')
})
