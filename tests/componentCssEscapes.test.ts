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
