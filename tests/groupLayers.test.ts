// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { groupElements, replaceElementsWith, setElementLink, ungroupElements } from '../src/lib/layers'

const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`
const bodyOf = (html: string) => new DOMParser().parseFromString(html, 'text/html').body.innerHTML

describe('groupElements', () => {
  it('wraps siblings in one named box where the first was', () => {
    const html = doc('<h1>a</h1><p>b</p><p>c</p><p>d</p>')
    const grouped = groupElements(
      html,
      ['body:nth-of-type(1) > p:nth-of-type(1)', 'body:nth-of-type(1) > p:nth-of-type(2)'],
      { name: 'Group' },
    )
    expect(bodyOf(grouped!.html)).toBe('<h1>a</h1><div data-doop-name="Group"><p>b</p><p>c</p></div><p>d</p>')
    expect(grouped!.selector).toBe('body:nth-of-type(1) > div:nth-of-type(1)')
  })

  it('gives an auto layout box its flex', () => {
    const grouped = groupElements(doc('<p>b</p>'), ['body:nth-of-type(1) > p:nth-of-type(1)'], {
      name: 'Frame',
      style: 'display: flex; gap: 8px',
    })
    expect(bodyOf(grouped!.html)).toBe('<div data-doop-name="Frame" style="display: flex; gap: 8px"><p>b</p></div>')
  })

  it('refuses layers in different boxes', () => {
    const html = doc('<div><p>a</p></div><p>b</p>')
    expect(
      groupElements(
        html,
        ['body:nth-of-type(1) > div:nth-of-type(1) > p:nth-of-type(1)', 'body:nth-of-type(1) > p:nth-of-type(1)'],
        { name: 'G' },
      ),
    ).toBeNull()
  })

  it('refuses rows of a table', () => {
    const html = doc('<table><tbody><tr><td>a</td></tr></tbody></table>')
    expect(
      groupElements(html, ['body:nth-of-type(1) > table:nth-of-type(1) > tbody:nth-of-type(1) > tr:nth-of-type(1)'], {
        name: 'G',
      }),
    ).toBeNull()
  })
})

describe('ungroupElements', () => {
  it('puts a box’s children where the box was', () => {
    const freed = ungroupElements(doc('<h1>a</h1><div><p>b</p><p>c</p></div>'), [
      'body:nth-of-type(1) > div:nth-of-type(1)',
    ])
    expect(bodyOf(freed!.html)).toBe('<h1>a</h1><p>b</p><p>c</p>')
    expect(freed!.selectors).toEqual([
      'body:nth-of-type(1) > p:nth-of-type(1)',
      'body:nth-of-type(1) > p:nth-of-type(2)',
    ])
  })

  it('leaves a box with text of its own', () => {
    expect(ungroupElements(doc('<div>hi <b>there</b></div>'), ['body:nth-of-type(1) > div:nth-of-type(1)'])).toBeNull()
  })
})

describe('setElementLink', () => {
  it('wraps the content in a link, then retargets and removes it', () => {
    const linked = setElementLink(doc('<p>Docs</p>'), 'body:nth-of-type(1) > p:nth-of-type(1)', 'https://a.test')!
    expect(bodyOf(linked)).toBe('<p><a href="https://a.test">Docs</a></p>')
    const moved = setElementLink(linked, 'body:nth-of-type(1) > p:nth-of-type(1)', 'https://b.test')!
    expect(bodyOf(moved)).toBe('<p><a href="https://b.test">Docs</a></p>')
    expect(bodyOf(setElementLink(moved, 'body:nth-of-type(1) > p:nth-of-type(1)', null)!)).toBe('<p>Docs</p>')
  })

  it('retargets a picked link itself', () => {
    const html = doc('<a href="/x">Go</a>')
    expect(bodyOf(setElementLink(html, 'body:nth-of-type(1) > a:nth-of-type(1)', '/y')!)).toBe('<a href="/y">Go</a>')
  })
})

describe('replaceElementsWith', () => {
  it('swaps the picked layers for the clipboard’s, where the first was', () => {
    const html = doc('<p>a</p><p>b</p><p>c</p>')
    const replaced = replaceElementsWith(
      html,
      ['body:nth-of-type(1) > p:nth-of-type(1)', 'body:nth-of-type(1) > p:nth-of-type(3)'],
      '<h2>new</h2>',
    )
    expect(bodyOf(replaced!.html)).toBe('<h2>new</h2><p>b</p>')
    expect(replaced!.selectors).toEqual(['body:nth-of-type(1) > h2:nth-of-type(1)'])
  })

  it('refuses loose text', () => {
    expect(replaceElementsWith(doc('<p>a</p>'), ['body:nth-of-type(1) > p:nth-of-type(1)'], 'just text')).toBeNull()
  })
})
