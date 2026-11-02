// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'
import { copyLayer, copyLayers, hasElementClip, pasteLayer } from '../src/lib/elementClipboard'
import { copyFrames, hasFrameClip } from '../src/lib/frameClipboard'
import { insertElement } from '../src/lib/layers'
import { useStore } from '../src/lib/store'
import { deleteLayer } from '../src/lib/layerEdits'
import { clearHistory, redo, undo } from '../src/lib/history'

vi.mock('../src/lib/api', () => ({ api: { updateFrame: vi.fn().mockResolvedValue({}) } }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const frame: Frame = {
  id: 'f',
  canvasId: 'c',
  name: 'Frame',
  x: 0,
  y: 0,
  width: 300,
  height: 200,
  html: '<div id="source"><label for="field">Name</label><input id="field"></div><p id="target">Target</p>',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Tester',
}

beforeEach(() => {
  clearHistory()
  localStorage.clear()
  useStore.getState().setCanvas({ id: 'c', name: 'Canvas', frames: [frame], createdAt: 0, updatedAt: 0 })
})

afterEach(() => vi.restoreAllMocks())

describe('element clipboard', () => {
  it('undoes a rapid paste and delete as separate actions', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    copyLayer(frame, '#source')
    expect(pasteLayer(frame, '#target')).toBe(true)
    const pasted = useStore.getState().canvas!.frames[0]!
    expect(deleteLayer(pasted, '#source-copy')).toBe(true)
    const deleted = useStore.getState().canvas!.frames[0]!.html

    await undo()
    expect(useStore.getState().canvas!.frames[0]!.html).toBe(pasted.html)
    await undo()
    expect(useStore.getState().canvas!.frames[0]!.html).toBe(frame.html)
    await redo()
    expect(useStore.getState().canvas!.frames[0]!.html).toBe(pasted.html)
    await redo()
    expect(useStore.getState().canvas!.frames[0]!.html).toBe(deleted)
  })

  it('pastes one layer after the target, updates references, and selects the copy', () => {
    expect(copyLayer(frame, '#source')).toBe(true)
    expect(pasteLayer(frame, '#target')).toBe(true)
    const html = useStore.getState().canvas!.frames[0]!.html
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(doc.querySelector('#target')?.nextElementSibling?.id).toBe('source-copy')
    expect(doc.querySelector('#source-copy label')?.getAttribute('for')).toBe('field-copy')
    expect(useStore.getState().selectedElement).toEqual({ frameId: 'f', selector: '#source-copy' })
  })

  it('uses the latest destination document and can paste onto blank frame space', () => {
    copyLayer(frame, '#source')
    useStore.getState().patchFrameLocal(frame.id, { html: '<p id="new">Collaborator edit</p>' })
    expect(pasteLayer(frame, null)).toBe(true)
    expect(useStore.getState().canvas!.frames[0]!.html).toContain('Collaborator edit')
  })

  it('refuses a missing target or a locked frame or ancestor', () => {
    copyLayer(frame, '#source')
    expect(pasteLayer(frame, '#missing')).toBe(false)
    useStore.getState().patchFrameLocal(frame.id, { locked: true })
    expect(pasteLayer(frame, null)).toBe(false)
    useStore
      .getState()
      .patchFrameLocal(frame.id, { locked: false, html: '<div data-doop-locked><p id="target"></p></div>' })
    expect(pasteLayer(frame, '#target')).toBe(false)
  })

  it('replaces the other kind of clipboard when copying frames or elements', () => {
    copyFrames([frame])
    copyLayer(frame, '#source')
    expect(hasFrameClip()).toBe(false)
    expect(hasElementClip()).toBe(true)
    copyFrames([frame])
    expect(hasElementClip()).toBe(false)
    expect(hasFrameClip()).toBe(true)
  })

  it('gives each paste a scope of its own, with the carried sheet renamed to match', () => {
    const styled: Frame = {
      ...frame,
      id: 'styled',
      html: '<!doctype html><html><head><style>.hi{color:red}</style></head><body><p class="hi">x</p></body></html>',
    }
    const other: Frame = {
      ...frame,
      id: 'other',
      html: '<!doctype html><html><head></head><body><b>y</b></body></html>',
    }
    useStore.getState().setCanvas({ id: 'c', name: 'Canvas', frames: [styled, other], createdAt: 0, updatedAt: 0 })
    copyLayer(styled, '.hi')
    expect(pasteLayer(other, null)).toBe(true)
    expect(
      pasteLayer(
        useStore.getState().canvas!.frames.find((f) => f.id === 'other')!,
        null,
      ),
    ).toBe(true)
    const html = useStore.getState().canvas!.frames.find((f) => f.id === 'other')!.html
    const scopes = [...html.matchAll(/<p class="hi" data-doop-carried-scope="(\w+)"/g)].map((m) => m[1])
    expect(scopes).toHaveLength(2)
    expect(new Set(scopes).size).toBe(2)
    for (const scope of scopes)
      expect(html).toContain(`[data-doop-carried-scope="${scope}"] *):is(.hi) { color: red; }`)
  })

  it('gives each copied root its own scope, with the CSS collected for it alone', () => {
    const styled: Frame = {
      ...frame,
      id: 'styled',
      html: '<!doctype html><html><head><style>.red{--ink:red} .blue{--ink:blue} .card{color:var(--ink)}</style></head><body><div class="red"><p class="card">a</p></div><div class="blue"><p class="card">b</p></div></body></html>',
    }
    const other: Frame = {
      ...frame,
      id: 'other',
      html: '<!doctype html><html><head></head><body><b>y</b></body></html>',
    }
    useStore.getState().setCanvas({ id: 'c', name: 'Canvas', frames: [styled, other], createdAt: 0, updatedAt: 0 })
    expect(copyLayers(styled, ['.red > .card', '.blue > .card'])).toBe(true)
    expect(pasteLayer(other, null)).toBe(true)
    const html = useStore.getState().canvas!.frames.find((f) => f.id === 'other')!.html
    const scopes = [...html.matchAll(/<p class="card" data-doop-carried-scope="(\w+)">/g)].map((m) => m[1]!)
    expect(scopes).toHaveLength(2)
    expect(html).toContain(`[data-doop-carried-scope="${scopes[0]}"] {\n  --ink: red;`)
    expect(html).toContain(`[data-doop-carried-scope="${scopes[1]}"] {\n  --ink: blue;`)
  })

  it('keeps SVG paint references inside the pasted artwork', () => {
    const svg =
      '<svg id="art"><defs><linearGradient id="paint"></linearGradient></defs><rect fill="url(#paint)"></rect></svg>'
    const inserted = insertElement(svg, '#art', svg)!
    const doc = new DOMParser().parseFromString(inserted.html, 'text/html')
    expect(doc.querySelector('#art-copy rect')?.getAttribute('fill')).toBe('url(#paint-copy)')
  })

  it.each([
    ['tr', '<table><tbody><tr id="source"><td>First</td></tr><tr id="target"><td>Second</td></tr></tbody></table>'],
    ['td', '<table><tbody><tr><td id="source">First</td><td id="target">Second</td></tr></tbody></table>'],
    [
      'tbody',
      '<table><tbody id="source"><tr><td>First</td></tr></tbody><tbody id="target"><tr><td>Second</td></tr></tbody></table>',
    ],
  ])('copies and pastes a %s in its existing table', (tag, html) => {
    const table = { ...frame, html: html! }
    useStore.getState().patchFrameLocal(frame.id, { html: table.html })
    expect(copyLayer(table, '#source')).toBe(true)
    expect(pasteLayer(table, '#target')).toBe(true)
    const doc = new DOMParser().parseFromString(useStore.getState().canvas!.frames[0]!.html, 'text/html')
    const copy = doc.querySelector('#source-copy')!
    expect(copy.localName).toBe(tag)
    expect(copy.textContent).toBe('First')
    expect(doc.querySelector('#target')?.nextElementSibling).toBe(copy)
  })

  it('rejects markup that would be lost or rearranged on serialization', () => {
    expect(insertElement('<p id="target"></p>', '#target', '<tr><td>cell</td></tr>')).toBeNull()
    expect(insertElement('<p id="target"></p>', '#target', '<div>A</div><div>B</div>')).toBeNull()
    expect(insertElement('<p id="target"></p>', '#target', 'lost text<div>A</div>')).toBeNull()
  })
})
