// @vitest-environment happy-dom
// @vitest-environment-options { "happyDOM": { "settings": { "disableCSSFileLoading": true } } }
import { afterEach, expect, it, vi } from 'vitest'
import { clipToFrame, inlineDocument, pinViewportUnits } from '../src/lib/frameRaster'

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

it('crops to a clip by its viewBox and paints a ground under the document', async () => {
  serve({})
  const svg = await inlineDocument('<html><body><h1>Hi</h1></body></html>', {
    ...opts(),
    clip: { x: 10, y: 20, width: 40, height: 30 },
    background: '#fff',
  })
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30" viewBox="10 20 40 30">')).toBe(
    true,
  )
  /* the document is still laid out at the frame's size */
  expect(svg).toContain('<rect width="300" height="200" fill="#fff"/><foreignObject width="300" height="200">')
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
  expect(svg).toContain('<style media="print">@import url("data:text/css;base64,')
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

it('writes viewport units as the frame px, leaving words and data URLs alone', () => {
  const size = { width: 400, height: 200 }
  expect(pinViewportUnits('body{height:100vh;width:50vw}', size)).toBe('body{height:200px;width:200px}')
  expect(pinViewportUnits('a{margin:-10vh 25vmin;padding:calc(100dvh - 2px) 1.5vmax}', size)).toBe(
    'a{margin:-20px 50px;padding:calc(200px - 2px) 6px}',
  )
  const data = 'src:url(data:font/woff2;base64,AAb3vh+Q9vw/AA==)'
  expect(pinViewportUnits(data, size)).toBe(data)
  expect(pinViewportUnits('.x3vh{} @media (min-width: 1px)', size)).toBe('.x3vh{} @media (min-width: 1px)')
})

it('pins viewport units only when asked, in sheets and style attributes', async () => {
  serve({})
  const html = '<html><head><style>body{height:100vh}</style></head><body><p style="width:50vw">x</p></body></html>'
  const pinned = await inlineDocument(html, { ...opts(), standalone: true })
  expect(pinned).toContain('body{height:200px}')
  expect(pinned).toContain('style="width:150px"')
  expect(await inlineDocument(html, opts())).toContain('body{height:100vh}')
})

it('drops what would run once the file is opened as a page', async () => {
  serve({})
  const svg = await inlineDocument(
    '<html><body onload="go()"><a href="javascript:alert(1)" onclick="go()">x</a>' +
      '<a href=" JavaScript:go()">y</a><a href="https://doop.design">z</a>' +
      '<form action="javascript:go()"><button formaction="javascript:go()">b</button></form>' +
      '<svg><a xlink:href="javascript:go()"><rect onmouseover="go()"/></a></svg></body></html>',
    opts(),
  )
  expect(svg).not.toMatch(/javascript:|onload|onclick|onmouseover/i)
  expect(svg).toContain('href="https://doop.design"')
})
