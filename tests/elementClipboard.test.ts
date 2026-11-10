// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'
import type { ResourceCopyEntry, ResourceCopyResult } from '../shared/resourceCopies'
import {
  copyLayer,
  copyLayers,
  copyPicked,
  hasElementClip,
  pasteLayer,
  replaceWithClip,
} from '../src/lib/elementClipboard'
import { copyFrames, hasFrameClip } from '../src/lib/frameClipboard'
import { insertElement } from '../src/lib/layers'
import { useStore } from '../src/lib/store'
import { deleteLayer, duplicateLayers, standaloneSelector } from '../src/lib/layerEdits'
import { clearHistory, redo, undo } from '../src/lib/history'

const createFrame = vi.fn((_canvasId: string, frame: Partial<Frame>) => Promise.resolve({ ...frame, id: 'new' }))
const updateFrame = vi.fn().mockResolvedValue({})
const copyResources = vi.fn<(canvasId: string, entries: ResourceCopyEntry[]) => Promise<ResourceCopyResult>>()
vi.mock('../src/lib/api', () => ({
  errorMessage: (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback),
  api: {
    updateFrame: (...args: unknown[]) => updateFrame(...args),
    copyResources: (canvasId: string, entries: ResourceCopyEntry[]) => copyResources(canvasId, entries),
    createFrame: (canvasId: string, frame: Partial<Frame>) => createFrame(canvasId, frame),
  },
}))
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
  updateFrame.mockClear()
  copyResources.mockReset().mockImplementation(async (canvasId, entries) => ({
    canvasId,
    entries: entries.map((entry) => ({
      html: entry.html.replaceAll('/a/source.png', '/a/owned.png'),
      css: entry.css?.replaceAll('/a/source.png', '/a/owned.png'),
    })),
    assets: [{ from: 'source', to: 'owned', url: '/a/owned.png' }],
  }))
  useStore.getState().setCanvas({ id: 'c', name: 'Canvas', frames: [frame], createdAt: 0, updatedAt: 0 })
})

afterEach(() => vi.restoreAllMocks())

describe('explicit cross-canvas layer clipboard', () => {
  function prepare() {
    const source = { ...frame, id: 'source', updatedAt: 7, html: '<div id="piece"><img src="/a/source.png"></div>' }
    useStore.getState().setCanvas({ id: 'c', name: 'Source', frames: [source], createdAt: 1, updatedAt: 1 })
    expect(copyLayer(source, '#piece')).toBe(true)
    const target = {
      ...frame,
      id: 'destination-frame',
      canvasId: 'destination',
      updatedAt: 11,
      html: '<div id="target">Target</div>',
    }
    useStore
      .getState()
      .setCanvas({ id: 'destination', name: 'Destination', frames: [target], createdAt: 1, updatedAt: 1 })
    return target
  }

  it('waits for the explicit owned mapping before the normal layer save', async () => {
    const target = prepare()
    expect(pasteLayer(target, '#target')).toBe(true)
    await vi.waitFor(() => expect(copyResources).toHaveBeenCalledTimes(1))
    expect(copyResources.mock.calls[0]![1][0]).toMatchObject({ sourceFrameId: 'source', sourceVersion: 7 })
    await vi.waitFor(() => expect(updateFrame).toHaveBeenCalledTimes(1))
    expect(updateFrame.mock.calls[0]![1].html).toContain('/a/owned.png')
    expect(useStore.getState().canvas!.frames[0]!.html).not.toContain('/a/source.png')
  })

  it('reports source denial and leaves the destination unchanged without retry', async () => {
    const target = prepare()
    copyResources.mockRejectedValueOnce(new Error('Source file is not available'))
    expect(pasteLayer(target, '#target')).toBe(true)
    await vi.waitFor(() => expect(useStore.getState().notice?.text).toBe('Source file is not available'))
    expect(copyResources).toHaveBeenCalledTimes(1)
    expect(updateFrame).not.toHaveBeenCalled()
    expect(useStore.getState().canvas!.frames[0]!.html).toBe(target.html)
  })

  it('refuses a late paste when the target revision changed while files were copied', async () => {
    const target = prepare()
    let release!: (value: ResourceCopyResult) => void
    copyResources.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    expect(pasteLayer(target, '#target')).toBe(true)
    useStore.getState().patchFrameLocal(target.id, { html: '<p>new target revision</p>', updatedAt: 12 })
    release({ canvasId: target.canvasId, entries: [{ html: '<img src="/a/owned.png">', css: '' }], assets: [] })
    await vi.waitFor(() => expect(useStore.getState().notice?.text).toContain('destination changed'))
    expect(updateFrame).not.toHaveBeenCalled()
    expect(useStore.getState().canvas!.frames[0]!.html).toBe('<p>new target revision</p>')
  })

  it('replaces layers only after source-version admission and owned HTML/CSS remapping', async () => {
    const target = prepare()
    expect(replaceWithClip(target, ['#target'])).toBe(true)
    expect(updateFrame).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(updateFrame).toHaveBeenCalledTimes(1))
    expect(copyResources.mock.calls[0]![1][0]).toMatchObject({ sourceFrameId: 'source', sourceVersion: 7 })
    const html = useStore.getState().canvas!.frames[0]!.html
    expect(html).toContain('/a/owned.png')
    expect(html).not.toContain('/a/source.png')
    expect(html).not.toContain('>Target<')
    await undo()
    expect(useStore.getState().canvas!.frames[0]!.html).toBe(target.html)
  })

  it('keeps layers and history unchanged when replacement source admission is refused', async () => {
    const target = prepare()
    copyResources.mockRejectedValueOnce(new Error('Source file is not available'))
    expect(replaceWithClip(target, ['#target'])).toBe(true)
    await vi.waitFor(() => expect(useStore.getState().notice?.text).toBe('Source file is not available'))
    expect(copyResources).toHaveBeenCalledTimes(1)
    expect(updateFrame).not.toHaveBeenCalled()
    expect(useStore.getState().canvas!.frames[0]!.html).toBe(target.html)
  })

  for (const changed of ['revision', 'navigation', 'history', 'lock'] as const) {
    it(`refuses replacement after a delayed copy and destination ${changed} change`, async () => {
      const target = prepare()
      let release!: (value: ResourceCopyResult) => void
      copyResources.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve
          }),
      )
      expect(replaceWithClip(target, ['#target'])).toBe(true)
      if (changed === 'revision') useStore.getState().patchFrameLocal(target.id, { html: '<p>new revision</p>' })
      if (changed === 'navigation')
        useStore.getState().setCanvas({ id: 'other', name: 'Other', frames: [], createdAt: 1, updatedAt: 1 })
      if (changed === 'history') clearHistory()
      if (changed === 'lock') useStore.getState().patchFrameLocal(target.id, { locked: true })
      release({ canvasId: target.canvasId, entries: [{ html: '<img src="/a/owned.png">', css: '' }], assets: [] })
      await vi.waitFor(() => expect(useStore.getState().notice?.text).toContain('destination changed'))
      expect(updateFrame).not.toHaveBeenCalled()
    })
  }
})

/* a shape drawn on the canvas: a transparent shell holding its one layer */
const shape: Frame = {
  ...frame,
  id: 'shape',
  html: '<!doctype html><html><head></head><body data-doop-canvas-element="true"><div data-doop-drawing="rect" data-name="Rectangle"></div></body></html>',
}

describe('standalone element copy', () => {
  beforeEach(() => {
    createFrame.mockClear()
    useStore.getState().setCanvas({ id: 'c', name: 'Canvas', frames: [frame, shape], createdAt: 0, updatedAt: 0 })
  })

  it('copies a picked standalone shape as the element it is, not as a layer of its shell', () => {
    const selector = standaloneSelector(shape)!
    expect(copyPicked(shape, [selector])).toBe(true)
    expect(hasFrameClip()).toBe(true)
    expect(hasElementClip()).toBe(false)
    /* a paste lands nothing inside the original's shell */
    expect(pasteLayer(shape, selector)).toBe(false)
    expect(useStore.getState().canvas!.frames[1]!.html).toBe(shape.html)
  })

  it('still copies a picked layer of an ordinary frame as a layer', () => {
    expect(copyPicked(frame, ['#source'])).toBe(true)
    expect(hasElementClip()).toBe(true)
    expect(hasFrameClip()).toBe(false)
  })

  it('duplicates a picked standalone shape as a second element on the canvas', async () => {
    const selector = standaloneSelector(shape)!
    useStore.getState().pickElement({ frameId: shape.id, selector })
    duplicateLayers(shape, [selector])
    await vi.waitFor(() => expect(createFrame).toHaveBeenCalledTimes(1))
    expect(createFrame.mock.calls[0]![1]).toMatchObject({ html: shape.html, x: 40, y: 40, width: 300, height: 200 })
    expect(useStore.getState().canvas!.frames[1]!.html).toBe(shape.html)
  })
})

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
