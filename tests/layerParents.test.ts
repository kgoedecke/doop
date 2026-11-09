// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'

vi.mock('../src/lib/api', () => ({
  api: { updateFrame: vi.fn(() => Promise.resolve()), deleteFrame: () => Promise.resolve() },
  ApiError: class extends Error {},
  errorMessage: (_err: unknown, fallback: string) => fallback,
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
/* every box lays out as a flex row: grouping must carry that onto the group */
const computedStyles = vi.fn((_frameId: string, _selector: string, _props: string[]) =>
  Promise.resolve({
    display: 'flex',
    'flex-direction': 'row',
    'flex-wrap': 'nowrap',
    'align-items': 'center',
    'justify-content': 'flex-start',
    'row-gap': '0px',
    'column-gap': '8px',
  }),
)
vi.mock('../src/lib/frameBridge', () => ({
  requestFrame: () => Promise.resolve(null),
  inspectElement: () => Promise.resolve(null),
  settleFrames: () => Promise.resolve(),
  computedStyles: (frameId: string, selector: string, props: string[]) => computedStyles(frameId, selector, props),
}))

const { useStore } = await import('../src/lib/store')
const { isElementHidden } = await import('../src/lib/layers')
const { groupSelection, hideOthers, selectInverse } = await import('../src/lib/actions/edits')

/* a layer anchored on its id: its path names nothing above it */
const HTML = `<!doctype html>
<html><head></head><body><header><p>logo</p></header><section><h1 id="title">Hi</h1><p>lede</p><p>more</p></section></body></html>`
const HEADER = 'body:nth-of-type(1) > header:nth-of-type(1)'
const SECTION = 'body:nth-of-type(1) > section:nth-of-type(1)'
const TITLE = '#title'
const LEDE = `${SECTION} > p:nth-of-type(1)`
const MORE = `${SECTION} > p:nth-of-type(2)`

const frame: Frame = {
  id: 'f1',
  canvasId: 'c1',
  name: 'f1',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: HTML,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'me',
}
const html = () => useStore.getState().canvas?.frames[0]?.html ?? ''

beforeEach(() => {
  computedStyles.mockClear()
  useStore.getState().setCanvas({ id: 'c1', name: 'Canvas', frames: [frame] } as Canvas)
  useStore.setState({ role: 'edit' } as never)
  useStore.getState().select('f1')
  useStore.getState().pickElement({ frameId: 'f1', selector: TITLE })
})

describe('a layer whose path starts at its id', () => {
  it('inverts the pick among its own siblings', () => {
    expect(selectInverse()).toBe(true)
    expect([...useStore.getState().selectedElements].sort()).toEqual([LEDE, MORE].sort())
  })

  it('hides its siblings and nothing above it', () => {
    expect(hideOthers()).toBe(true)
    expect(isElementHidden(html(), LEDE)).toBe(true)
    expect(isElementHidden(html(), MORE)).toBe(true)
    expect(isElementHidden(html(), TITLE)).toBe(false)
    expect(isElementHidden(html(), SECTION)).toBe(false)
    expect(isElementHidden(html(), HEADER)).toBe(false)
  })
})

describe('grouping keeps the layout of the box it groups in', () => {
  it('reads the body for layers directly inside it', async () => {
    useStore.getState().pickElements('f1', [HEADER, SECTION])
    expect(groupSelection('group')).toBe(true)
    await vi.waitFor(() => expect(html()).toContain('display: flex'))
    expect(computedStyles.mock.calls[0]?.[1]).toBe('body:nth-of-type(1)')
  })

  it('reads the real parent of a layer whose path starts at its id', async () => {
    useStore.getState().pickElements('f1', [TITLE, LEDE])
    expect(groupSelection('group')).toBe(true)
    await vi.waitFor(() => expect(html()).toContain('display: flex'))
    expect(computedStyles.mock.calls[0]?.[1]).toBe(SECTION)
  })
})
