import { describe, expect, it } from 'vitest'
import { parse } from 'parse5'
import type { DefaultTreeAdapterTypes as Tree } from 'parse5'
import { extractComponentCss, unmatchedSelectors, unreadCss } from '../server/componentCss.ts'

/*
 * Customer report (2026-11-19): a kit lifted from Storybook drew half styled. Tailwind escapes
 * the quotes in a class like `[&_svg:not([class*='size-'])]:size-4` (`\'size-\'`), and the
 * stylesheet reader took the escaped quote for the start of a string, so every rule after the
 * first such class was dropped without a word.
 */
function rootOf(html: string): Tree.Element {
  const stack: Tree.Node[] = [parse(html)]
  for (let node = stack.pop(); node; node = stack.pop()) {
    if ('tagName' in node && node.attrs.some((attr) => attr.name === 'data-main')) return node
    if ('childNodes' in node) stack.push(...node.childNodes)
  }
  throw new Error('no main')
}

const BUTTON = rootOf(
  `<button data-main class="btn [&_svg:not([class*='size-'])]:size-4 w-[24px] hover:bg-accent"><svg></svg><span class="label">Go</span></button>`,
)

/* as Tailwind writes them */
const TAILWIND = String.raw`
.btn { display: inline-flex }
.\[\&_svg\:not\(\[class\*\=\'size-\'\]\)\]\:size-4 svg:not([class*='size-']) { width: 16px; height: 16px }
.w-\[24px\] { width: 24px }
.hover\:bg-accent:hover { background: var(--accent) }
.label { color: red }
`

describe('Tailwind classes in a component’s CSS', () => {
  const { rawCss } = extractComponentCss(TAILWIND, BUTTON, 'cmp')

  it('keeps every rule after an escaped quote', () => {
    expect(rawCss).toContain('width: 16px')
    expect(rawCss).toContain('width: 24px')
    expect(rawCss).toContain('background: var(--accent)')
    expect(rawCss).toContain('color: red')
  })

  it('matches the escaped classes to the elements wearing them', () => {
    expect(unmatchedSelectors(TAILWIND, BUTTON)).toEqual([])
  })

  it('reads the sheet to the end', () => {
    expect(unreadCss(TAILWIND)).toBeNull()
  })

  it('keeps an escaped brace part of the name', () => {
    const root = rootOf('<div data-main class="a{b"></div>')
    const sheet = String.raw`.a\{b { color: red } .a\{b span { color: blue }`
    expect(unreadCss(sheet)).toBeNull()
    expect(extractComponentCss(sheet, root, 'cmp').rawCss).toContain('color: red')
  })
})

describe('a sheet that cannot be read to the end', () => {
  it('names where a string left open swallows the rest', () => {
    const sheet = `.a { color: red } .b { content: 'open } .c { color: blue }`
    expect(unreadCss(sheet)).toMatch(/^\.b \{ content: 'open/)
  })

  it('names a block never closed', () => {
    expect(unreadCss('.a { color: red } .b { color: blue')).toBe('.b { color: blue')
  })

  it('names text outside any rule, and still reads the rules after it', () => {
    const root = rootOf('<div data-main class="a"><p class="b"></p></div>')
    const sheet = '.a { color: red } color: green; .b { color: blue }'
    expect(unreadCss(sheet)).toMatch(/^color: green;/)
    expect(extractComponentCss(sheet, root, 'cmp').rawCss).toContain('color: blue')
  })

  it('names trouble inside a media query', () => {
    expect(unreadCss(`@media (min-width: 1px) { .a { color: red } stray } .b { color: blue }`)).toBe('stray')
  })

  it('cuts a long excerpt', () => {
    const excerpt = unreadCss(`.a { content: '${'x'.repeat(400)} }`)!
    expect(excerpt.length).toBeLessThanOrEqual(121)
    expect(excerpt.endsWith('…')).toBe(true)
  })
})

/*
 * Comments were cut with a regex before the quote-aware read, so a `/*` inside a string or an
 * unquoted url(…) opened a "comment" that ran to the next real one and took the rules between.
 */
describe('comments in a component’s CSS', () => {
  const ROOT = rootOf('<div data-main class="a"><p class="b"></p><span class="c"></span></div>')
  const rawCssOf = (sheet: string) => extractComponentCss(sheet, ROOT, 'cmp').rawCss

  it('keeps the rules after a /* inside a string', () => {
    const sheet = '.a{content:"/*"} .b{color:red} /* note */ .c{color:blue}'
    expect(unreadCss(sheet)).toBeNull()
    expect(rawCssOf(sheet)).toContain('color:red')
    expect(rawCssOf(sheet)).toContain('content:"/*"')
    expect(rawCssOf(sheet)).not.toContain('note')
  })

  it('ends a comment at the first */ even inside quotes', () => {
    const sheet = `.a { color: red } /* it's "*/" .b { color: blue }`
    expect(unreadCss(sheet)).toMatch(/^" \.b \{ color: blue \}/)
  })

  it('reads quotes inside a comment as comment text', () => {
    const sheet = `/* it's the card's "frame */ .a { color: red } /* don't */ .b { color: blue }`
    expect(unreadCss(sheet)).toBeNull()
    expect(rawCssOf(sheet)).toContain('color: red')
    expect(rawCssOf(sheet)).toContain('color: blue')
  })

  it('keeps an escaped quote inside the string that holds the /*', () => {
    const sheet = String.raw`.a { content: "\"/*" } .b { color: red } /* note */ .c { color: blue }`
    expect(unreadCss(sheet)).toBeNull()
    expect(rawCssOf(sheet)).toContain('color: red')
  })

  it('reads a /* inside an unquoted url() as part of the url', () => {
    const sheet = '.a { background: url(https://cdn.test/img/*.png) } .b { color: red } /* note */ .c { color: blue }'
    expect(unreadCss(sheet)).toBeNull()
    expect(rawCssOf(sheet)).toContain('url(https://cdn.test/img/*.png)')
    expect(rawCssOf(sheet)).toContain('color: red')
  })

  it('reads braces inside an unquoted url() as part of the url', () => {
    const sheet = '.a { background: url(/img/*}*/x.png) } .b { color: red } .c { background: url(a{b}c.png) }'
    expect(unreadCss(sheet)).toBeNull()
    expect(rawCssOf(sheet)).toContain('url(/img/*}*/x.png)')
    expect(rawCssOf(sheet)).toContain('color: red')
    expect(rawCssOf(sheet)).toContain('url(a{b}c.png)')
  })

  it('reads a /* inside a quoted url() as part of the string', () => {
    const sheet = `.a { background: URL( '/img/*.png' ) } .b { color: red } /* note */ .c { color: blue }`
    expect(unreadCss(sheet)).toBeNull()
    expect(rawCssOf(sheet)).toContain(`URL( '/img/*.png' )`)
    expect(rawCssOf(sheet)).toContain('color: red')
  })

  it('drops comments between selectors, blocks and declarations', () => {
    const sheet =
      '.a /* the card */ { color: red /* ; } */ ; } .a, /* and */ .b { color: blue } .a/**/ .c { margin: 0 }'
    expect(unreadCss(sheet)).toBeNull()
    expect(unmatchedSelectors(sheet, ROOT)).toEqual([])
    const raw = rawCssOf(sheet)
    expect(raw).not.toContain('/*')
    expect(raw).toContain('.a, .b')
    expect(raw).toContain('.a .c')
  })

  it('keeps the rules after a /* in a string inside a media query', () => {
    const sheet = '@media (min-width: 1px) { .a { content: "/*" } .b { color: red } } /* note */ .c { color: blue }'
    expect(unreadCss(sheet)).toBeNull()
    expect(rawCssOf(sheet)).toContain('color: red')
  })

  it('still cuts the comments after a url( never closed', () => {
    const sheet = '.a { background: url(x.png } /* note */ .b { color: red }'
    expect(unmatchedSelectors(sheet, ROOT)).toEqual([])
    expect(rawCssOf(sheet)).not.toContain('note')
  })

  it('shows a comment never closed inside a block in what it names', () => {
    expect(unreadCss('.a { color: red; /* open')).toBe('.a { color: red; /* open')
    expect(unreadCss('@media (x) { .a { color: red } /* open')).toBe('@media (x) { .a { color: red } /* open')
  })

  it('names a comment never closed, which runs to the end as in a browser', () => {
    const sheet = '.a { color: red } /* open .b { color: blue }'
    expect(unreadCss(sheet)).toBe('/* open .b { color: blue }')
    expect(rawCssOf(sheet)).toContain('color: red')
    expect(rawCssOf(sheet)).not.toContain('color: blue')
  })
})
