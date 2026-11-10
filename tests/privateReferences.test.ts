import { describe, expect, it } from 'vitest'
import { privateAssetUrl, PrivateReferenceError, visitPrivateReferences } from '../shared/privateReferences.ts'

const ORIGIN = 'https://doop.test'
function ids(source: string) {
  const found: string[] = []
  const original = visitPrivateReferences(source, ORIGIN, (reference) => {
    found.push(reference.id)
  })
  expect(original).toBe(source)
  return found
}

describe('parsed private reference positions', () => {
  it.each([
    ['HTML entity', '<img src="&#47;a/owner.png">'],
    ['protocol relative', '<img src="//doop.test/a/owner.png">'],
    ['SVG namespaced link', '<svg><image xlink:href="/a/owner.png" /></svg>'],
    ['SVG use', '<svg><use href="/a/owner.svg#symbol" /></svg>'],
    ['SVG presentation URL', '<svg><rect fill="url(/a/owner.svg#gradient)" /></svg>'],
    ['CSS URL', '<div style="background:url(/a/owner.png)"></div>'],
    ['CSS escape', String.raw`<style>.hero { background: url(\2f a/owner.png) }</style>`],
    ['escaped URL function', String.raw`<style>.hero { background: u\72l("/a/owner.png") }</style>`],
    ['custom CSS property', '<style>:root { --hero: url(/a/owner.png) }</style>'],
    ['CSS import string', '<style>@import "/a/owner.woff2";</style>'],
    [
      'CSS image-set string',
      '<style>div { background:image-set("/a/owner.png" 1x, "https://example.test/external.png" 2x) }</style>',
    ],
    ['nested srcdoc', '<iframe srcdoc="&lt;img src=&quot;/a/owner.png&quot;&gt;"></iframe>'],
    ['template', '<template><img src="/a/owner.png"></template>'],
    ['document base', '<img src="owner.png"><base href="/a/">'],
  ])('recognizes %s without reserializing source', (_name, source) => {
    expect(ids(source)).toEqual(['owner'])
  })

  it('handles srcset descriptors and data-URI commas with the selected parser', () => {
    expect(
      ids(
        '<img srcset="data:image/png;base64,AAAA 1x, /a/owner.png 2x"><link imagesrcset="/a/second.webp 320w, /a/third.webp 640w">',
      ),
    ).toEqual(['owner', 'second', 'third'])
  })

  it('keeps ordinary text, comments and CSS string values as data', () => {
    expect(
      ids(
        '<pre>/a/owner.png</pre><!-- <img src="/a/owner.png"> --><style>p::before { content:"/a/owner.png" } /* url(/a/owner.png) */</style><script>const data="/a/owner.png"</script>',
      ),
    ).toEqual([])
  })

  it('does not let inert XML, template or SVG bases disguise private paths', () => {
    expect(
      ids(
        '<svg xml:base="https://external.test/"><image href="/a/owner.png" /></svg><div xml:base="https://external.test/"><img src="/a/second.png"></div>',
      ),
    ).toEqual(['owner', 'second'])
    expect(ids('<template><base href="https://external.test/a/"></template><img src="/a/owner.png">')).toEqual([
      'owner',
    ])
    expect(ids('<svg><base href="https://external.test/a/" /></svg><img src="/a/owner.png">')).toEqual(['owner'])
    expect(ids('<base href="https://external.test/"><img src="/a/owner.png">')).toEqual(['owner'])
    expect(ids('<svg xml:base="/a/"><image href="owner.png" /></svg>')).toEqual([])
    expect(ids('<template><base href="/a/"></template><img src="owner.png">')).toEqual([])
    expect(ids('<svg><base href="/a/" /></svg><img src="owner.png">')).toEqual([])
    expect(
      ids('<template><base href="https://external.test/"></template><base href="/a/"><img src="owner.png">'),
    ).toEqual(['owner'])
  })

  it('accepts normal CSS EOF recovery during streaming without changing source', () => {
    expect(ids('<style>a{color:rgb(')).toEqual([])
    expect(ids('<style>a{background:url(/a/owner.png)')).toEqual(['owner'])
  })

  it.each([
    ['stylesheet', String.raw`.hero{background:u\72l("/a/owner.png")} .label{content:"/a/plain.png"}`],
    ['value', 'image-set("/a/owner.png" 1x, url(/a/second.png) 2x)'],
  ] as const)('validates and rewrites the explicit raw CSS %s context', (context, source) => {
    const seen: string[] = []
    const replaced = visitPrivateReferences(
      source,
      ORIGIN,
      (reference) => {
        seen.push(reference.id)
        return `${ORIGIN}/a/copied_${reference.id}.${reference.ext}`
      },
      context,
    )
    expect(seen).toEqual(context === 'value' ? ['owner', 'second'] : ['owner'])
    expect(replaced).toContain('copied_owner.png')
    if (context === 'stylesheet') expect(replaced).toContain('content:"/a/plain.png"')
    expect(visitPrivateReferences(source, ORIGIN, () => {}, context)).toBe(source)
  })

  it('uses the actual document base and exact configured origin', () => {
    expect(
      ids(
        '<base href="https://external.test/a/"><img src="owner.png"><img src="https://doop.test.evil/a/owner.png"><img src="https://doop.test/a/owned.png">',
      ),
    ).toEqual(['owned'])
    expect(privateAssetUrl('/a/owner.svg#symbol', ORIGIN)).toMatchObject({ id: 'owner', ext: 'svg', hash: '#symbol' })
  })

  it.each([
    '/a/%6fwner.png',
    '/a/owner.exe',
    '/a/owner.png?credential=secret',
    'https://user:password@doop.test/a/owner.png',
  ])('refuses unsupported private URL %s', (url) => {
    expect(() => ids(`<img src="${url}">`)).toThrow(PrivateReferenceError)
  })

  it('rewrites only explicit URL carriers, including nested HTML and escaped CSS', () => {
    const source = String.raw`<pre>/a/owner.png</pre><svg><image xlink:href="/a/owner.png" /></svg><style>.x { background:u\72l("/a/owner.png") }</style><iframe srcdoc="&lt;img srcset=&quot;/a/owner.png 1x, data:image/png;base64,AAAA 2x&quot;&gt;"></iframe>`
    const copy = visitPrivateReferences(
      source,
      ORIGIN,
      (reference) => `${ORIGIN}/a/copied.${reference.ext}${reference.hash}`,
    )
    expect(ids(copy)).toEqual(['copied', 'copied', 'copied'])
    expect(copy).toContain('<pre>/a/owner.png</pre>')
    expect(copy).toContain('data:image/png;base64,AAAA')
  })
})

describe('reference work and nesting budgets', () => {
  it.each([
    ['source bytes', 'x'.repeat(1024 * 1024 + 1)],
    ['HTML depth', '<div>'.repeat(40)],
    ['CSS depth', `<style>a{color:${'f('.repeat(1000)}red${')'.repeat(1000)}}</style>`],
    ['unbalanced CSS', '<style>a { color: ))f(red) }</style>'],
    ['URL count', '<img src="/a/owner.png">'.repeat(65)],
    ['AST work', '<b></b>'.repeat(17000)],
  ])('refuses excess %s with a controlled error', (_name, source) => {
    expect(() => ids(source)).toThrow(PrivateReferenceError)
  })
})

it('the shared parser works without a Node Buffer global and resolves rewrites against the actual CSS base', () => {
  const original = globalThis.Buffer
  let rewritten = ''
  const visited: string[] = []
  try {
    globalThis.Buffer = undefined as unknown as typeof Buffer
    rewritten = visitPrivateReferences(
      '.x{background:u\\72l("./image.png")}',
      'https://doop.example',
      () => {},
      'stylesheet',
      {
        base: 'https://cdn.example/theme/main.css',
        url: (raw, base) => {
          visited.push(new URL(raw, base).href)
          return 'data:image/png;base64,YQ=='
        },
      },
    )
  } finally {
    globalThis.Buffer = original
  }
  expect(visited).toEqual(['https://cdn.example/theme/image.png'])
  expect(rewritten).toContain('data:image/png;base64,YQ==')
})

it('a generic rewrite cannot bypass the private-reference owner callback', () => {
  expect(() =>
    visitPrivateReferences(
      '<img src="/a/own-image.png">',
      'https://doop.example',
      () => {
        throw new Error('scope denied')
      },
      'html',
      { url: () => 'data:image/png;base64,YQ==' },
    ),
  ).toThrow('scope denied')
})
