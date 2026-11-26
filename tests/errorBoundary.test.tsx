// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const captured = vi.hoisted(() => vi.fn())
vi.mock('../src/lib/posthog', () => ({ captureCaughtError: captured }))

const { ErrorBoundary } = await import('../src/components/ui/error-boundary')
const { Panel } = await import('../src/components/ui/panel')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  /* React and the boundary both log a caught error; keep the run quiet */
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  captured.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  consoleError.mockRestore()
})

/* a panel that reads data it did not expect, the way a real one fails */
const broken = { on: true }
function LayersList({ name = 'Layers' }: { name?: string }) {
  if (broken.on) throw new TypeError("Cannot read properties of null (reading 'connected')")
  return <p>{name} is fine</p>
}

const alert = () => container.querySelector('[role="alert"]')
const retry = () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!

it('shows the fallback in place of a child that throws, reports it once, and Retry mounts it again', () => {
  broken.on = true
  act(() =>
    root.render(
      <ErrorBoundary>
        <LayersList />
      </ErrorBoundary>,
    ),
  )
  expect(alert()?.textContent).toContain('This couldn’t be shown')
  expect(consoleError).toHaveBeenCalledWith('[LayersList] failed to render', expect.any(TypeError), expect.any(String))
  expect(captured).toHaveBeenCalledOnce()
  expect(captured).toHaveBeenCalledWith(
    expect.any(TypeError),
    expect.objectContaining({ error_component: 'LayersList' }),
  )

  broken.on = false
  act(() => retry().click())
  expect(alert()).toBeNull()
  expect(container.textContent).toBe('Layers is fine')
})

it('reports a failure that arrives with a new reset key once, and a repeat of it not again', () => {
  broken.on = false
  /* a frame that a new version breaks: the key changes in the same update
     that throws, then keeps changing while it stays broken */
  const view = (version: number) => (
    <ErrorBoundary resetKey={{ version }}>
      <LayersList />
    </ErrorBoundary>
  )
  act(() => root.render(view(1)))
  broken.on = true
  act(() => root.render(view(2)))
  expect(alert()).not.toBeNull()
  act(() => root.render(view(3)))
  expect(alert()).not.toBeNull()
  expect(captured).toHaveBeenCalledOnce()
})

it('tries again by itself when its reset key changes', () => {
  broken.on = true
  const view = (frameId: string) => (
    <ErrorBoundary resetKey={frameId}>
      <LayersList name={frameId} />
    </ErrorBoundary>
  )
  act(() => root.render(view('a')))
  expect(alert()).not.toBeNull()

  broken.on = false
  act(() => root.render(view('b')))
  expect(container.textContent).toBe('b is fine')
})

it('keeps a failure inside its panel, and the panel beside it keeps its draft', () => {
  broken.on = false
  let crashLayers = () => {}
  function Layers() {
    const [crashed, setCrashed] = useState(false)
    crashLayers = () => setCrashed(true)
    if (crashed) throw new TypeError("Cannot read properties of undefined (reading 'name')")
    return <p>Layers</p>
  }
  act(() =>
    root.render(
      <>
        <Panel data-testid="layers">
          <Layers />
        </Panel>
        <Panel data-testid="agents">
          <textarea aria-label="Composer" defaultValue="" />
        </Panel>
      </>,
    ),
  )
  const composer = container.querySelector('textarea')!
  composer.value = 'Make the hero darker'

  act(() => crashLayers())

  /* the fallback sits inside the Layers panel, which keeps its place */
  expect(alert()?.closest('[data-testid]')?.getAttribute('data-testid')).toBe('layers')
  /* the composer is the same node, still holding what was typed */
  expect(container.querySelector('textarea')).toBe(composer)
  expect(composer.value).toBe('Make the hero darker')
})
