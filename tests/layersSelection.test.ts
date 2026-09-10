import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/lib/api', () => ({ api: {} }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { useStore } = await import('../src/lib/store')

/* the element outlined in a frame is shared between the frame surface and
   the Layers rail — the store is what keeps the two views on one element */
describe('selectedElement', () => {
  beforeEach(() => {
    useStore.setState({
      selectedId: null,
      selectedIds: [],
      selectedElement: null,
      inspectorOpen: false,
      elementPanelOpen: false,
    })
  })

  it('is kept while the same frame stays selected', () => {
    useStore.getState().select('a')
    useStore.getState().setSelectedElement({ frameId: 'a', selector: 'body:nth-of-type(1) > div:nth-of-type(1)' })
    useStore.getState().select('a')
    expect(useStore.getState().selectedElement?.selector).toBe('body:nth-of-type(1) > div:nth-of-type(1)')
  })

  it('is dropped when the selection moves to another frame or clears', () => {
    useStore.getState().select('a')
    useStore.getState().setSelectedElement({ frameId: 'a', selector: 'body:nth-of-type(1) > div:nth-of-type(1)' })
    useStore.getState().select('b')
    expect(useStore.getState().selectedElement).toBeNull()

    useStore.getState().setSelectedElement({ frameId: 'b', selector: '#hero' })
    useStore.getState().selectMany(['a', 'c'])
    expect(useStore.getState().selectedElement).toBeNull()

    useStore.getState().setSelectedElement({ frameId: 'c', selector: '#hero' })
    useStore.getState().select(null)
    expect(useStore.getState().selectedElement).toBeNull()
  })

  it('does not produce a new state object for a repeat of the same element', () => {
    const el = { frameId: 'a', selector: '#hero' }
    useStore.getState().setSelectedElement(el)
    const before = useStore.getState().selectedElement
    useStore.getState().setSelectedElement({ ...el })
    expect(useStore.getState().selectedElement).toBe(before)
  })

  it('closes the element panel when the selection leaves the frame', () => {
    useStore.getState().select('a')
    useStore.getState().setSelectedElement({ frameId: 'a', selector: '#hero' })
    useStore.getState().setElementPanelOpen(true)
    useStore.getState().select('a')
    expect(useStore.getState().elementPanelOpen).toBe(true)
    useStore.getState().select('b')
    expect(useStore.getState().elementPanelOpen).toBe(false)
  })
})
