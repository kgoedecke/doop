// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { findInHtml, replaceInHtml } from '../src/lib/actions/findText'

const doc = (body: string) =>
  `<!doctype html><html><head><title>Plan</title><style>.plan{}</style></head><body>${body}</body></html>`
const bodyOf = (html: string) => new DOMParser().parseFromString(html, 'text/html').body.innerHTML

describe('findInHtml', () => {
  const html = doc('<h1>Pricing plan</h1><p>Pick a <b>Plan</b> today.</p><script>var plan = 1</script>')

  it('finds text a person reads, never scripts, styles or the title', () => {
    expect(findInHtml(html, 'plan').map((m) => m.selector)).toEqual([
      'body:nth-of-type(1) > h1:nth-of-type(1)',
      'body:nth-of-type(1) > p:nth-of-type(1) > b:nth-of-type(1)',
    ])
  })

  it('matches case when asked', () => {
    expect(findInHtml(html, 'Plan', { matchCase: true })).toHaveLength(1)
  })

  it('carries the text around the match', () => {
    const [first] = findInHtml(html, 'plan')
    expect(first).toMatchObject({ before: 'Pricing ', text: 'plan', after: '' })
  })
})

describe('replaceInHtml', () => {
  it('replaces every match, or only the one named', () => {
    const html = doc('<p>cat cat</p><p>cat</p>')
    expect(bodyOf(replaceInHtml(html, 'cat', 'dog')!.html)).toBe('<p>dog dog</p><p>dog</p>')
    expect(bodyOf(replaceInHtml(html, 'cat', 'dog', { only: 1 })!.html)).toBe('<p>cat dog</p><p>cat</p>')
    expect(bodyOf(replaceInHtml(html, 'cat', 'dog', { only: 2 })!.html)).toBe('<p>cat cat</p><p>dog</p>')
  })

  it('counts what it replaced and refuses a miss', () => {
    expect(replaceInHtml(doc('<p>a a</p>'), 'a', 'b')!.count).toBe(2)
    expect(replaceInHtml(doc('<p>a</p>'), 'z', 'b')).toBeNull()
  })

  it('leaves markup that looks like the query alone', () => {
    const html = doc('<p class="cat">cat</p>')
    expect(bodyOf(replaceInHtml(html, 'cat', 'dog')!.html)).toBe('<p class="cat">dog</p>')
  })

  it('finds text in a locked layer but never replaces it, keeping the numbering', () => {
    const html = doc('<p data-doop-locked="true">cat</p><p>cat</p>')
    expect(findInHtml(html, 'cat').map((m) => m.locked)).toEqual([true, false])
    expect(bodyOf(replaceInHtml(html, 'cat', 'dog')!.html)).toBe('<p data-doop-locked="true">cat</p><p>dog</p>')
    expect(replaceInHtml(html, 'cat', 'dog', { only: 0 })).toBeNull()
    expect(bodyOf(replaceInHtml(html, 'cat', 'dog', { only: 1 })!.html)).toBe(
      '<p data-doop-locked="true">cat</p><p>dog</p>',
    )
  })

  it('keeps offsets where lower-casing changes a string’s length', () => {
    const html = doc('<p>İ cat!</p>')
    expect(findInHtml(html, 'CAT')[0]).toMatchObject({ before: 'İ ', text: 'cat', after: '!' })
    expect(bodyOf(replaceInHtml(html, 'CAT', 'dog')!.html)).toBe('<p>İ dog!</p>')
  })

  it('finds regular-expression characters literally', () => {
    expect(bodyOf(replaceInHtml(doc('<p>a.b (c)</p>'), '(c)', '[d]')!.html)).toBe('<p>a.b [d]</p>')
  })
})
