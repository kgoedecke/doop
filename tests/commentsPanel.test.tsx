// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Canvas, ElementComment } from '../shared/types'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/components/TeamAllowance', () => ({ isResidentLimit: () => false }))

const { CommentsPanel } = await import('../src/components/CommentsPanel')
const { useStore } = await import('../src/lib/store')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it.each(['frame', 'canvas'])('reads resolved %s replies in chronological order', (anchor) => {
  const comment: ElementComment = {
    id: 'root',
    canvasId: 'c',
    from: 'Ada',
    text: 'Review the heading',
    at: 1,
    snippet: '',
    resolvedAt: 100,
    resolvedBy: 'Bob',
    ...(anchor === 'frame' ? { frameId: 'f' } : { pageId: 'p', x: 10, y: 20 }),
  }
  useStore.setState({
    canvas: { id: 'c', pages: [{ id: 'p', name: 'Page' }], frames: [{ id: 'f', pageId: 'p', name: 'Hero' }] } as Canvas,
    activePageId: 'p',
    comments: [
      { ...comment, id: 'late', parentId: 'root', from: 'Bob', text: 'Done\nReady to ship', at: 3 },
      comment,
      { ...comment, id: 'early', parentId: 'root', from: 'Ada', text: 'Please make it larger', at: 2 },
    ],
  })
  act(() => root.render(<CommentsPanel />))
  const resolved = [...container.querySelectorAll('button')].find((el) => el.textContent?.startsWith('Resolved'))!
  act(() => resolved.click())
  expect(container.textContent).toContain('Review the heading')
  const expand = container.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')!
  expect(expand.textContent).toContain('2 replies')
  expect(expand.getAttribute('aria-expanded')).toBe('false')
  act(() => expand.click())
  expect(expand.getAttribute('aria-expanded')).toBe('true')
  const replies = [...container.querySelectorAll('ol[aria-label="Resolved replies"] li')]
  expect(replies.map((el) => el.querySelector('p')?.textContent)).toEqual([
    'Please make it larger',
    'Done\nReady to ship',
  ])
  expect(replies[0]?.textContent).toContain('Ada')
  expect(replies[1]?.textContent).toContain('Bob')
  expect(container.querySelector('input')).toBeNull()
})
