// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'
import type { ResourceCopyResult } from '../shared/resourceCopies'
const mocks = vi.hoisted(() => ({ computed: vi.fn(), inspect: vi.fn(), copy: vi.fn(), update: vi.fn() }))
vi.mock('../src/lib/frameBridge', () => ({
  computedStyles: mocks.computed,
  inspectElement: mocks.inspect,
  styleElement: vi.fn(),
  editElementGeometry: vi.fn(),
  settleFrames: vi.fn(async () => {}),
}))
vi.mock('../src/lib/api', () => ({ api: { copyResources: mocks.copy, updateFrame: mocks.update } }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
import { copyProperties, pasteProperties, hasStyleClip } from '../src/lib/actions/edits'
import { useStore } from '../src/lib/store'
import { clearHistory, undo } from '../src/lib/history'

const source: Frame = {
  id: 'source',
  canvasId: 'source-canvas',
  name: 'Source',
  x: 0,
  y: 0,
  width: 320,
  height: 240,
  createdAt: 1,
  updatedAt: 7,
  updatedBy: 'Owner',
  html: '<style>@font-face{font-family:Private;src:url(/a/source.woff2)}</style><div id="piece" style="font-family:Private;background-image:url(/a/source.png)">Source</div>',
}
const target: Frame = {
  ...source,
  id: 'target',
  canvasId: 'destination',
  updatedAt: 11,
  html: '<div id="piece" style="width:99px">Target</div>',
}
function select(frame: Frame) {
  useStore.getState().setCanvas({ id: frame.canvasId, name: 'Canvas', frames: [frame], createdAt: 1, updatedAt: 1 })
  useStore.getState().pickElement({ frameId: frame.id, selector: '#piece' })
}
beforeEach(() => {
  clearHistory()
  localStorage.clear()
  useStore.setState({ notice: null })
  mocks.update.mockReset().mockResolvedValue({})
  mocks.inspect.mockReset().mockResolvedValue({ hasText: true })
  mocks.computed.mockReset().mockResolvedValue({
    'background-image': 'url("/a/source.png")',
    'background-color': 'rgb(1, 2, 3)',
    'font-family': 'Private',
    'font-size': '18px',
  })
  mocks.copy.mockReset().mockImplementation(async (canvasId, entries) => ({
    canvasId,
    assets: [],
    entries: entries.map((entry: { html: string; css: string }) => ({
      html: entry.html.replaceAll('/a/source.png', '/a/owned.png'),
      css: entry.css.replaceAll('/a/source.woff2', '/a/owned.woff2'),
    })),
  }))
})
async function copied() {
  select(source)
  expect(await copyProperties()).toBe(true)
  const retained = localStorage.getItem('doop:style-clip')!
  expect(retained).toContain('sourceFrameId')
  expect(retained).not.toContain('doop-resource=')
  select(target)
}
it('admits computed image/font styles with source provenance before a single undoable destination rewrite', async () => {
  await copied()
  expect(await pasteProperties()).toBe(true)
  expect(mocks.copy).toHaveBeenCalledTimes(1)
  expect(mocks.copy.mock.calls[0]![1][0]).toMatchObject({ sourceFrameId: source.id, sourceVersion: 7 })
  expect(mocks.copy.mock.calls[0]![1][0].css).toContain('/a/source.woff2')
  const html = useStore.getState().canvas!.frames[0]!.html
  expect(html).toContain('/a/owned.png')
  expect(html).toContain('/a/owned.woff2')
  expect(html).not.toContain('/a/source.')
  expect(html).not.toContain('doop-resource=')
  expect(html).toContain('width: 99px')
  expect(mocks.update).toHaveBeenCalledTimes(1)
  await undo()
  expect(useStore.getState().canvas!.frames[0]!.html).toBe(target.html)
})
it('preserves ordinary literal properties through current source authorization', async () => {
  mocks.computed.mockResolvedValue({ 'background-color': 'rgb(5, 6, 7)', opacity: '0.5' })
  await copied()
  expect(await pasteProperties()).toBe(true)
  expect(mocks.copy).toHaveBeenCalledTimes(1)
  expect(useStore.getState().canvas!.frames[0]!.html).toContain('opacity: 0.5')
})
it('leaves destination HTML/history unchanged when the source is denied or revoked', async () => {
  await copied()
  mocks.copy.mockRejectedValueOnce(new Error('Source permission was revoked'))
  expect(await pasteProperties()).toBe(false)
  expect(mocks.update).not.toHaveBeenCalled()
  expect(useStore.getState().canvas!.frames[0]!.html).toBe(target.html)
  expect(useStore.getState().notice?.text).toBe('Source permission was revoked')
})
for (const changed of ['revision', 'navigation', 'history', 'lock'] as const) {
  it(`refuses property paste when the destination ${changed} changes during source admission`, async () => {
    await copied()
    let release!: (result: ResourceCopyResult) => void
    mocks.copy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const pending = pasteProperties()
    await vi.waitFor(() => expect(mocks.copy).toHaveBeenCalledTimes(1))
    if (changed === 'revision') useStore.getState().patchFrameLocal(target.id, { html: '<p>New revision</p>' })
    if (changed === 'navigation') select({ ...target, canvasId: 'other' })
    if (changed === 'history') clearHistory()
    if (changed === 'lock') useStore.getState().patchFrameLocal(target.id, { locked: true })
    release({
      canvasId: target.canvasId,
      entries: [{ html: '<div><div></div><div></div></div>', css: '' }],
      assets: [],
    })
    expect(await pending).toBe(false)
    expect(mocks.update).not.toHaveBeenCalled()
  })
}
it('refuses an unscoped or materialized persisted style clipboard', () => {
  localStorage.setItem('doop:style-clip', JSON.stringify({ visual: { color: 'red' }, text: null }))
  expect(hasStyleClip()).toBe(false)
  localStorage.setItem(
    'doop:style-clip',
    JSON.stringify({
      sourceFrameId: 'source',
      sourceCanvasId: 'c',
      sourceVersion: 1,
      fontCss: '',
      visual: { 'background-image': 'url(data:image/png;doop-resource=private;base64,bytes)' },
      text: null,
    }),
  )
  expect(hasStyleClip()).toBe(false)
})
