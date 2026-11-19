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

it('picks a person to @mention from the reply field and highlights mentions', async () => {
  const { api } = await import('../src/lib/api')
  vi.spyOn(api, 'canvasPeople').mockResolvedValue([
    { id: 'u1', name: 'Ada Lovelace' },
    { id: 'u2', name: 'Bob' },
  ])
  useStore.setState({
    canvas: {
      id: 'c2',
      pages: [{ id: 'p', name: 'Page' }],
      frames: [{ id: 'f', pageId: 'p', name: 'Hero' }],
    } as Canvas,
    activePageId: 'p',
    comments: [{ id: 'k', canvasId: 'c2', frameId: 'f', from: 'Bob', text: 'Ping @Ada Lovelace', at: 1, snippet: '' }],
  })
  await act(async () => root.render(<CommentsPanel />))
  const mention = [...container.querySelectorAll('span.text-brand')].map((el) => el.textContent)
  expect(mention).toContain('@Ada Lovelace')

  const input = container.querySelector('input')!
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    input.focus()
    setValue.call(input, 'thanks @ad')
    input.setSelectionRange(10, 10)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const options = [...container.querySelectorAll('[role="option"]')].map((el) => el.textContent)
  expect(options[0]).toContain('Ada Lovelace')
  expect(options.some((o) => o?.includes('Bob'))).toBe(false)
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  expect(input.value).toBe('thanks @Ada Lovelace ')
  expect(container.querySelector('[role="listbox"]')).toBeNull()
})

it('offers a comment-only visitor people, not agents, and closes the list on blur', async () => {
  const { api } = await import('../src/lib/api')
  vi.spyOn(api, 'canvasPeople').mockResolvedValue([{ id: 'u1', name: 'Dora' }])
  useStore.setState({
    canvas: {
      id: 'c3',
      role: 'comment',
      pages: [{ id: 'p', name: 'Page' }],
      frames: [{ id: 'f', pageId: 'p', name: 'Hero' }],
    } as Canvas,
    activePageId: 'p',
    comments: [{ id: 'k', canvasId: 'c3', frameId: 'f', from: 'Bob', text: 'Hi', at: 1, snippet: '' }],
  })
  await act(async () => root.render(<CommentsPanel />))
  const input = container.querySelector('input')!
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    input.focus()
    setValue.call(input, '@d')
    input.setSelectionRange(2, 2)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const options = [...container.querySelectorAll('[role="option"]')].map((el) => el.textContent)
  expect(options).toEqual(['DODora'])
  expect(input.getAttribute('aria-activedescendant')).toBeTruthy()
  act(() => input.blur())
  expect(container.querySelector('[role="listbox"]')).toBeNull()
})

it('sends only the latest pick of a shared name, and forgets picks once the reply is sent', async () => {
  const { api } = await import('../src/lib/api')
  vi.spyOn(api, 'canvasPeople').mockResolvedValue([
    { id: 's1', name: 'Sam' },
    { id: 's2', name: 'Sam' },
  ])
  const reply = vi.spyOn(api, 'replyComment').mockResolvedValue(undefined as never)
  useStore.setState({
    canvas: {
      id: 'c4',
      pages: [{ id: 'p', name: 'Page' }],
      frames: [{ id: 'f', pageId: 'p', name: 'Hero' }],
    } as Canvas,
    activePageId: 'p',
    comments: [{ id: 'k', canvasId: 'c4', frameId: 'f', from: 'Bob', text: 'Hi', at: 1, snippet: '' }],
  })
  await act(async () => root.render(<CommentsPanel />))
  const input = container.querySelector('input')!
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  const type = (text: string) =>
    act(() => {
      input.focus()
      setValue.call(input, text)
      input.setSelectionRange(text.length, text.length)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  const key = (k: string) => act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))
  const settle = () => act(() => new Promise((r) => setTimeout(r, 40)))

  type('@sa')
  key('Enter') // the first Sam
  await settle()
  type('@sa')
  key('ArrowDown')
  key('Enter') // the second Sam, in place of the first
  await settle()
  expect(input.value).toBe('@Sam ')
  key('Enter')
  await settle()
  expect(reply).toHaveBeenLastCalledWith('k', expect.any(String), ['s2'])

  type('@Sam again')
  key('Enter')
  await settle()
  expect(reply).toHaveBeenLastCalledWith('k', expect.any(String), [])
})
