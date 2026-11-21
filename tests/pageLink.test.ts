import { describe, expect, it } from 'vitest'
import { libraryLandingPageId } from '../shared/pages'
import type { ComponentDef } from '../shared/components'
import type { Canvas, Frame } from '../shared/types'
import { defaultPageId, openingPageId, pageLink, pageSearch } from '../src/lib/pageLink'

const frame = (id: string, pageId?: string): Frame => ({
  id,
  canvasId: 'c',
  pageId,
  name: id,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: '',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Tester',
})

const canvas = (patch: Partial<Canvas> = {}): Canvas => ({
  id: 'c',
  name: 'Canvas',
  pages: [
    { id: 'first', name: 'Page 1' },
    { id: 'second', name: 'Exploration' },
    { id: 'parts', name: 'Components' },
  ],
  frames: [frame('home', 'first'), frame('draft', 'second'), frame('button', 'parts'), frame('legacy')],
  createdAt: 0,
  updatedAt: 0,
  ...patch,
})

const def = (id: string, mainFrameId: string | null) => ({ id, name: id, mainFrameId }) as ComponentDef

describe('which page a canvas URL opens', () => {
  it('opens the first page when the URL names nothing', () => {
    expect(openingPageId(canvas(), '')).toBe('first')
    expect(openingPageId(canvas(), '?import=1&connect=1')).toBe('first')
  })

  it('opens the page the URL names', () => {
    expect(openingPageId(canvas(), '?page=second')).toBe('second')
  })

  it('falls back to the default for a page that is not on the canvas', () => {
    expect(openingPageId(canvas(), '?page=deleted')).toBe('first')
    expect(openingPageId(canvas({ landingPageId: 'parts' }), '?page=deleted')).toBe('parts')
  })

  it("lets a frame link's page win over the page parameter", () => {
    expect(openingPageId(canvas(), '?page=first&frame=draft')).toBe('second')
    expect(openingPageId(canvas({ landingPageId: 'parts' }), '?frame=home&element=abc123')).toBe('first')
  })

  it('reads a frame saved before pages as on the first page', () => {
    expect(openingPageId(canvas(), '?page=second&frame=legacy')).toBe('first')
  })

  it('ignores a frame that is gone and goes by the page', () => {
    expect(openingPageId(canvas(), '?frame=deleted&page=second')).toBe('second')
    expect(openingPageId(canvas(), '?frame=deleted')).toBe('first')
  })

  it('opens a library on its components page, unless that page is gone or the link names one', () => {
    const library = canvas({ landingPageId: 'parts' })
    expect(defaultPageId(library)).toBe('parts')
    expect(openingPageId(library, '')).toBe('parts')
    expect(openingPageId(library, '?page=first')).toBe('first')
    expect(defaultPageId(canvas({ landingPageId: 'deleted' }))).toBe('first')
  })

  it('opens a canvas without stored pages on its one implied page', () => {
    expect(openingPageId(canvas({ pages: undefined }), '?page=second')).toBe('c:page1')
  })
})

describe('the query the address bar carries for the open page', () => {
  it('names the page, and nothing on the default page', () => {
    expect(pageSearch(canvas(), '', 'second')).toBe('?page=second')
    expect(pageSearch(canvas(), '?page=second', 'first')).toBe('')
    expect(pageSearch(canvas(), '', 'first')).toBe('')
  })

  it('removes a page that is not on the canvas', () => {
    expect(pageSearch(canvas(), '?page=deleted', 'first')).toBe('')
  })

  it('keeps every other parameter', () => {
    expect(pageSearch(canvas(), '?import=1&connect=1', 'second')).toBe('?import=1&connect=1&page=second')
    expect(pageSearch(canvas(), '?page=second&import=1', 'first')).toBe('?import=1')
  })

  it('leaves a frame or element link on the open page alone', () => {
    expect(pageSearch(canvas(), '?frame=draft&element=abc123', 'second')).toBe('?frame=draft&element=abc123')
    expect(pageSearch(canvas(), '?frame=draft&comment=c1', 'second')).toBe('?frame=draft&comment=c1')
    expect(pageSearch(canvas(), '?page=first&frame=draft', 'second')).toBe('?frame=draft')
  })

  it('drops a frame, element or comment link once another page is open', () => {
    expect(pageSearch(canvas(), '?frame=draft&element=abc123', 'parts')).toBe('?page=parts')
    expect(pageSearch(canvas(), '?frame=draft&comment=c1', 'first')).toBe('')
    expect(pageSearch(canvas(), '?page=second&comment=c1', 'parts')).toBe('?page=parts')
  })

  it('keeps a canvas comment link while its page is open', () => {
    expect(pageSearch(canvas(), '?page=second&comment=c1', 'second')).toBe('?page=second&comment=c1')
  })

  it('drops a link to a frame that is gone', () => {
    expect(pageSearch(canvas(), '?frame=deleted&element=abc123', 'first')).toBe('')
  })

  it('names the first page on a library, whose bare link opens its components', () => {
    const library = canvas({ landingPageId: 'parts' })
    expect(pageSearch(library, '', 'parts')).toBe('')
    expect(pageSearch(library, '', 'first')).toBe('?page=first')
  })

  it('round-trips: the query written for a page opens that page', () => {
    for (const subject of [canvas(), canvas({ landingPageId: 'parts' })])
      for (const search of ['', '?page=second', '?frame=draft&element=abc123', '?page=deleted&import=1'])
        for (const page of subject.pages!)
          expect(openingPageId(subject, pageSearch(subject, search, page.id))).toBe(page.id)
  })
})

describe('a page link', () => {
  it('always names the page', () => {
    expect(pageLink('c', 'first', 'https://doop.test')).toBe('https://doop.test/c/c?page=first')
    expect(pageLink('c', 'c:page1', 'https://doop.test')).toBe('https://doop.test/c/c?page=c%3Apage1')
  })
})

describe('the page a library canvas opens on', () => {
  it('is the page holding the most published mains', () => {
    const subject = canvas({
      frames: [frame('a', 'second'), frame('b', 'second'), frame('c', 'parts')],
      components: [def('A', 'a'), def('B', 'b'), def('C', 'c')],
    })
    expect(libraryLandingPageId(subject, ['A', 'B', 'C'])).toBe('second')
  })

  it('counts published components only', () => {
    const subject = canvas({
      frames: [frame('a', 'second'), frame('b', 'second'), frame('c', 'parts')],
      components: [def('A', 'a'), def('B', 'b'), def('C', 'c')],
    })
    expect(libraryLandingPageId(subject, ['C'])).toBe('parts')
  })

  it('breaks a tie with the page named Components, then with page order', () => {
    const tied = canvas({
      frames: [frame('a', 'first'), frame('b', 'second'), frame('c', 'parts')],
      components: [def('A', 'a'), def('B', 'b'), def('C', 'c')],
    })
    expect(libraryLandingPageId(tied, ['A', 'B', 'C'])).toBe('parts')
    expect(libraryLandingPageId(tied, ['A', 'B'])).toBe('first')
  })

  it('counts a main saved before pages on the first page', () => {
    const subject = canvas({ frames: [frame('legacy')], components: [def('A', 'legacy')] })
    expect(libraryLandingPageId(subject, ['A'])).toBe('first')
  })

  it('is nothing when no published component has a main frame', () => {
    const subject = canvas({ components: [def('Linked', null), def('Lost', 'deleted'), def('Private', 'button')] })
    expect(libraryLandingPageId(subject, ['Linked', 'Lost'])).toBeUndefined()
    expect(libraryLandingPageId(canvas(), [])).toBeUndefined()
  })
})
