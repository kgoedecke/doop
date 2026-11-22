// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('../src/App', () => ({ navigate: vi.fn() }))
vi.mock('../src/lib/auth', () => ({ authClient: {} }))
vi.mock('../src/lib/shell', async (load) => ({ ...(await load<object>()), isDesktopShell: () => true }))
vi.mock('../src/lib/api', () => ({ api: { createCanvas: () => new Promise(() => {}) } }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { navigate } = await import('../src/App')
const { DesktopTabs } = await import('../src/components/DesktopTabs')
const { useTabs } = await import('../src/lib/desktop')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const order = () => useTabs.getState().tabs.map((t) => t.id)
const listEl = () => {
  const el = container.querySelector<HTMLElement>('[role="tablist"]')
  if (!el) throw new Error('tab strip not rendered')
  return el
}
const tabEls = () => Array.from(listEl().children) as HTMLElement[]

/* happy-dom gives every element a zero rect; the drag's geometry needs
   real ones, so each tab reports a 100px-wide box laid out side by side */
const rect = (left: number, width: number) =>
  ({ left, right: left + width, top: 0, bottom: 36, width, height: 36, x: left, y: 0, toJSON: () => {} }) as DOMRect
function stubRects() {
  tabEls().forEach((el, i) => {
    el.getBoundingClientRect = () => rect(i * 100, 100)
  })
}

function pointer(type: string, clientX: number) {
  return new PointerEvent(type, { clientX, button: 0, pointerId: 7, pointerType: 'mouse', bubbles: true })
}
const down = (el: HTMLElement, x: number) =>
  act(() => {
    el.dispatchEvent(pointer('pointerdown', x))
  })
const move = (x: number) =>
  act(() => {
    document.dispatchEvent(pointer('pointermove', x))
  })
const release = (x: number) =>
  act(() => {
    document.dispatchEvent(pointer('pointerup', x))
  })
const click = (el: HTMLElement) =>
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

beforeEach(() => {
  vi.mocked(navigate).mockClear()
  useTabs.setState({
    tabs: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
    ],
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<DesktopTabs path="/c/a" />))
  stubRects()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('DesktopTabs drag reorder', () => {
  it('navigates on a click that never crossed the drag threshold', () => {
    const tab = tabEls()[0]!
    down(tab, 50)
    move(52)
    release(52)
    click(tab)
    expect(navigate).toHaveBeenCalledWith('/c/a')
    expect(order()).toEqual(['a', 'b', 'c'])
  })

  it('reorders on a drag past a sibling midpoint and swallows the drop click', () => {
    down(tabEls()[0]!, 50)
    move(160) /* past b's midpoint at 150 → drop slot 1 */
    release(160)
    expect(order()).toEqual(['b', 'a', 'c'])
    click(tabEls()[1]!)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('cancels on Escape and swallows the release click too', () => {
    down(tabEls()[0]!, 50)
    move(160)
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    release(160)
    click(tabEls()[1]!)
    expect(order()).toEqual(['a', 'b', 'c'])
    expect(navigate).not.toHaveBeenCalled()
  })

  it('drops the gesture when the tab list changes mid-drag', () => {
    down(tabEls()[0]!, 50)
    move(160)
    act(() => useTabs.setState({ tabs: useTabs.getState().tabs.slice(0, 2) }))
    release(160)
    click(tabEls()[1]!)
    /* the stale gesture applies no move, and its click goes nowhere */
    expect(order()).toEqual(['a', 'b'])
    expect(navigate).not.toHaveBeenCalled()
  })

  it('tracks the drop slot through a strip scroll mid-drag', () => {
    down(tabEls()[0]!, 50)
    move(160) /* slot 1 at this point: 160 has passed b's midpoint (150) only */
    act(() => {
      listEl().scrollLeft = 100
      listEl().dispatchEvent(new Event('scroll'))
    })
    release(160)
    /* the scroll listener re-slots in content coordinates: 160 + 100 has
       passed c's midpoint (250) as well, landing a last instead of second */
    expect(order()).toEqual(['b', 'c', 'a'])
  })
})
