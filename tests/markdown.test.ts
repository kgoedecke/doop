import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from '../src/lib/markdown'

/* Agents answer in the Agents tab chat with light markdown; it renders, it never runs as HTML. */
describe('parseMarkdown', () => {
  it('turns a bullet list with bold labels and inline code into a list', () => {
    const blocks = parseMarkdown(
      "Here's the new set:\n\n- **Kevin:** on `final_v3`.\n- **Calendar:** a review\n  continued here",
    )
    expect(blocks).toEqual([
      { kind: 'paragraph', lines: [[{ kind: 'text', text: "Here's the new set:" }]] },
      {
        kind: 'list',
        ordered: false,
        start: 1,
        items: [
          [
            { kind: 'strong', children: [{ kind: 'text', text: 'Kevin:' }] },
            { kind: 'text', text: ' on ' },
            { kind: 'code', text: 'final_v3' },
            { kind: 'text', text: '.' },
          ],
          [
            { kind: 'strong', children: [{ kind: 'text', text: 'Calendar:' }] },
            { kind: 'text', text: ' a review' },
            { kind: 'text', text: ' ' },
            { kind: 'text', text: 'continued here' },
          ],
        ],
      },
    ])
  })

  it('keeps numbered lists, headings, fenced code and line breaks', () => {
    const blocks = parseMarkdown('## Done\n3. one\n4. two\n\n```\n<div>\n```\nline a\nline b')
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'list', 'code', 'paragraph'])
    expect(blocks[1]).toMatchObject({ ordered: true, start: 3 })
    expect(blocks[2]).toEqual({ kind: 'code', text: '<div>' })
    expect(blocks[3]).toMatchObject({ lines: [[{ text: 'line a' }], [{ text: 'line b' }]] })
  })
})

describe('parseMarkdown fences', () => {
  it('leaves a fence that never closes as text, so a cut-short reply keeps its shape', () => {
    const blocks = parseMarkdown('```html\n<div>\n\n- still a list')
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'list'])
  })
})

describe('parseInline', () => {
  it('keeps dunder names as written', () => {
    expect(parseInline('edit __init__.py and __main__')).toEqual([
      { kind: 'text', text: 'edit __init__.py and __main__' },
    ])
  })

  it('reads bold italic and bold inside italics', () => {
    expect(parseInline('a ***b*** c')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'strong', children: [{ kind: 'em', children: [{ kind: 'text', text: 'b' }] }] },
      { kind: 'text', text: ' c' },
    ])
    expect(parseInline('*foo **bar** baz*')).toEqual([
      {
        kind: 'em',
        children: [
          { kind: 'text', text: 'foo ' },
          { kind: 'strong', children: [{ kind: 'text', text: 'bar' }] },
          { kind: 'text', text: ' baz' },
        ],
      },
    ])
  })

  it('keeps parentheses inside a link target', () => {
    expect(parseInline('[w](https://en.wikipedia.org/wiki/Foo_(bar)).')).toEqual([
      { kind: 'link', href: 'https://en.wikipedia.org/wiki/Foo_(bar)', children: [{ kind: 'text', text: 'w' }] },
      { kind: 'text', text: '.' },
    ])
  })

  it('leaves snake_case, lone stars and unsafe links as text', () => {
    expect(parseInline('a_b_c 2 * 3')).toEqual([{ kind: 'text', text: 'a_b_c 2 * 3' }])
    expect(parseInline('[x](javascript:alert(1))')).toEqual([{ kind: 'text', text: '[x](javascript:alert(1))' }])
  })

  it('reads italics and http links', () => {
    expect(parseInline('*so* [doop](https://doop.design)')).toEqual([
      { kind: 'em', children: [{ kind: 'text', text: 'so' }] },
      { kind: 'text', text: ' ' },
      { kind: 'link', href: 'https://doop.design', children: [{ kind: 'text', text: 'doop' }] },
    ])
  })
})
