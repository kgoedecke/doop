// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'

const updateFrame = vi.fn((_id: string, _patch: Partial<Frame>) => Promise.resolve())
vi.mock('../src/lib/api', () => ({
  api: { updateFrame: (id: string, patch: Partial<Frame>) => updateFrame(id, patch) },
  errorMessage: (_err: unknown, fallback: string) => fallback,
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/frameBridge', () => ({ requestFrame: () => Promise.resolve(null) }))

const { pickedSelectors, useStore } = await import('../src/lib/store')
const { duplicateElements, elementsHtml, insertElements, removeElements } = await import('../src/lib/layers')
const { deleteSelection, duplicateLayers, toggleLockSelection, toggleSelectionHidden } =
  await import('../src/lib/layerEdits')
const { copyLayers, pasteLayer } = await import('../src/lib/elementClipboard')
const { clearHistory, undo } = await import('../src/lib/history')

const page = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`
const P = (n: number) => `body:nth-of-type(1) > p:nth-of-type(${n})`
const THREE = page('<p>one</p><p>two</p><p>three</p>')

const frame = (html: string): Frame => ({
  id: 'f1',
  canvasId: 'c1',
  name: 'Frame',
  x: 0,
  y: 0,
  width: 300,
  height: 200,
  html,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Tester',
})

function load(html: string) {
  useStore.getState().setCanvas({ id: 'c1', name: 'Canvas', frames: [frame(html)], createdAt: 0, updatedAt: 0 })
  useStore.getState().select('f1')
}
const liveHtml = () => useStore.getState().canvas!.frames[0]!.html
const texts = (html: string) =>
  [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('p')].map((p) => p.textContent)

beforeEach(() => {
  clearHistory()
  localStorage.clear()
  useStore.setState({ selectedElement: null, selectedElements: [], elementPanelOpen: false })
})

describe('picked element set', () => {
  it('adds and drops elements of one frame, the latest pick primary', () => {
    const s = useStore.getState()
    s.pickElement({ frameId: 'a', selector: '#one' })
    s.toggleElement({ frameId: 'a', selector: '#two' })
    expect(useStore.getState().selectedElement).toEqual({ frameId: 'a', selector: '#two' })
    expect(pickedSelectors(useStore.getState())).toEqual(['#one', '#two'])

    s.toggleElement({ frameId: 'a', selector: '#two' })
    expect(useStore.getState().selectedElement).toEqual({ frameId: 'a', selector: '#one' })
    s.toggleElement({ frameId: 'a', selector: '#one' })
    expect(useStore.getState().selectedElement).toBeNull()
    expect(useStore.getState().elementPanelOpen).toBe(false)
  })

  it('starts a new set for an element in another frame', () => {
    const s = useStore.getState()
    s.pickElement({ frameId: 'a', selector: '#one' })
    s.toggleElement({ frameId: 'a', selector: '#two' })
    s.toggleElement({ frameId: 'b', selector: '#three' })
    expect(pickedSelectors(useStore.getState())).toEqual(['#three'])
  })

  it('keeps the set when the primary is re-picked, and collapses it on request', () => {
    const s = useStore.getState()
    s.pickElement({ frameId: 'a', selector: '#one' })
    s.toggleElement({ frameId: 'a', selector: '#two' })
    s.pickElement({ frameId: 'a', selector: '#two' })
    s.setSelectedElement({ frameId: 'a', selector: '#two' })
    expect(pickedSelectors(useStore.getState())).toEqual(['#one', '#two'])
    s.pickElement({ frameId: 'a', selector: '#two' }, true)
    expect(pickedSelectors(useStore.getState())).toEqual(['#two'])
  })

  it('ignores a stale set left behind by a path that set the primary alone', () => {
    useStore.setState({ selectedElement: { frameId: 'a', selector: '#x' }, selectedElements: ['#one', '#two'] })
    expect(pickedSelectors(useStore.getState())).toEqual(['#x'])
  })
})

describe('multi-element html edits', () => {
  it('resolves every selector before removing, so positional paths hold', () => {
    expect(texts(removeElements(THREE, [P(1), P(2)])!)).toEqual(['three'])
    expect(removeElements(THREE, [P(1), P(9)])).toBeNull()
  })

  it('removes and copies a nested pick with its box', () => {
    const html = page('<section><p>in</p></section><p>out</p>')
    const section = 'body:nth-of-type(1) > section:nth-of-type(1)'
    const inner = `${section} > p:nth-of-type(1)`
    expect(texts(removeElements(html, [inner, section])!)).toEqual(['out'])
    expect(elementsHtml(html, [inner, section])).toBe('<section><p>in</p></section>')
  })

  it('duplicates each element right after itself and reports where the copies landed', () => {
    const duplicated = duplicateElements(THREE, [P(3), P(1)])!
    expect(texts(duplicated.html)).toEqual(['one', 'one', 'two', 'three', 'three'])
    expect(duplicated.selectors).toEqual([P(2), P(5)])
  })

  it('keeps references between elements copied together on the copies', () => {
    const pair = page('<input id="a"><label for="a">Name</label>')
    const input = 'body:nth-of-type(1) > input:nth-of-type(1)'
    const label = 'body:nth-of-type(1) > label:nth-of-type(1)'
    const doc = (html: string) => new DOMParser().parseFromString(html, 'text/html')

    const duplicated = doc(duplicateElements(pair, [input, label])!.html)
    expect([...duplicated.querySelectorAll('label')].map((l) => l.htmlFor)).toEqual(['a', 'a-copy'])
    expect(duplicated.getElementById('a-copy')?.tagName).toBe('INPUT')

    const pasted = doc(insertElements(page(''), null, '<input id="a"><label for="a">Name</label>')!.html)
    expect(pasted.querySelector('label')?.htmlFor).toBe(pasted.querySelector('input')?.id)
  })

  it('copies in document order and pastes the layers together', () => {
    expect(elementsHtml(THREE, [P(3), P(1)])).toBe('<p>one</p><p>three</p>')
    const inserted = insertElements(THREE, P(2), '<p>one</p><p>three</p>')!
    expect(texts(inserted.html)).toEqual(['one', 'two', 'one', 'three', 'three'])
    expect(inserted.selectors).toEqual([P(3), P(4)])
  })
})

describe('multi-element selection commands', () => {
  function pickAll(...selectors: string[]) {
    const s = useStore.getState()
    s.pickElement(null)
    for (const selector of selectors) s.toggleElement({ frameId: 'f1', selector })
  }

  it('deletes every picked element as one undo step', async () => {
    load(THREE)
    pickAll(P(1), P(3))
    expect(deleteSelection()).toBe(true)
    expect(texts(liveHtml())).toEqual(['two'])
    expect(useStore.getState().selectedElement).toBeNull()
    await undo()
    expect(liveHtml()).toBe(THREE)
  })

  it('hides the set together, and shows it only once all are hidden', () => {
    load(THREE)
    pickAll(P(1), P(2))
    toggleSelectionHidden()
    expect(liveHtml().match(/data-doop-hidden/g)).toHaveLength(2)
    toggleSelectionHidden()
    expect(liveHtml()).not.toContain('data-doop-hidden')
  })

  it('locks the set together', () => {
    load(THREE)
    pickAll(P(2), P(3))
    expect(toggleLockSelection()).toBe(true)
    expect(liveHtml().match(/data-doop-locked/g)).toHaveLength(2)
  })

  it('picks the copies after duplicating the pick, so a later delete hits the right elements', () => {
    load(THREE)
    pickAll(P(1), P(3))
    duplicateLayers(useStore.getState().canvas!.frames[0]!, pickedSelectors(useStore.getState()))
    expect(pickedSelectors(useStore.getState())).toEqual([P(2), P(5)])
    deleteSelection()
    expect(texts(liveHtml())).toEqual(['one', 'two', 'three'])
  })

  it('refuses to delete a set holding a locked element', () => {
    load(page('<p>one</p><p data-doop-locked="true">two</p>'))
    pickAll(P(1), P(2))
    deleteSelection()
    expect(texts(liveHtml())).toEqual(['one', 'two'])
  })

  it('pastes a copied set after the primary and picks the copies', () => {
    load(THREE)
    expect(copyLayers(frame(THREE), [P(1), P(2)])).toBe(true)
    expect(pasteLayer(frame(THREE), P(3))).toBe(true)
    expect(texts(liveHtml())).toEqual(['one', 'two', 'three', 'one', 'two'])
    expect(pickedSelectors(useStore.getState())).toEqual([P(4), P(5)])
  })
})
