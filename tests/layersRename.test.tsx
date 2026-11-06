// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Canvas, Frame } from '../shared/types'

const updateFrame = vi.fn((_id: string, _patch: Partial<Frame>) => Promise.resolve())
vi.mock('../src/lib/api', () => ({
  api: { updateFrame: (id: string, patch: Partial<Frame>) => updateFrame(id, patch) },
  errorMessage: (_err: unknown, fallback: string) => fallback,
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
const requestFrame = vi.fn(() => Promise.resolve(null))
vi.mock('../src/lib/frameBridge', () => ({
  settleFrames: () => Promise.resolve(),
  requestFrame: (...args: unknown[]) => requestFrame(...(args as [])),
}))

const { useStore } = await import('../src/lib/store')
const { clearHistory, undo, redo } = await import('../src/lib/history')
const { renameFrame, renameLayer } = await import('../src/lib/layerEdits')
const { LayersPanel } = await import('../src/components/LayersPanel')
const { TooltipProvider } = await import('../src/components/ui/tooltip')

const frame: Frame = {
  id: 'f1',
  canvasId: 'c1',
  name: 'Frame',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: '<body><p>Hello</p></body>',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'me',
}
const image: Frame = {
  ...frame,
  id: 'image',
  name: 'photo.png',
  html: '<body data-doop-canvas-element="true"><img src="/photo.png" /></body>',
}

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
const reachedWindow = vi.fn()

function row(id: string) {
  return [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((el) =>
    id.includes('|') ? el.dataset.rowKey === id : el.dataset.rowKey?.split('|')[0] === id,
  )!
}
function input() {
  return container.querySelector<HTMLInputElement>('input[aria-label="Item name"]')!
}
function doubleClick(id: string) {
  act(() => row(id).dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
}
function press(key: string, isComposing = false) {
  act(() => input().dispatchEvent(new KeyboardEvent('keydown', { key, isComposing, bubbles: true })))
}
async function openMenu(id: string) {
  await act(async () => {
    row(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
  })
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === 'Rename')!
}

describe('renaming in the Layers panel', () => {
  beforeEach(() => {
    updateFrame.mockReset().mockResolvedValue()
    requestFrame.mockClear()
    reachedWindow.mockClear()
    window.addEventListener('keydown', reachedWindow)
    useStore.getState().setCanvas({ id: 'c1', name: 'Canvas', frames: [frame, image] } as Canvas)
    clearHistory()
    useStore.setState({ selectedId: null, selectedIds: [], selectedElement: null, notice: null, flyTo: null })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() =>
      root.render(
        <TooltipProvider>
          <LayersPanel onAddFrame={() => {}} />
        </TooltipProvider>,
      ),
    )
  })

  afterEach(async () => {
    window.removeEventListener('keydown', reachedWindow)
    await act(async () => root.unmount())
    container.remove()
  })

  it.each(['f1', 'image'])('renames %s on double-click, with undo and redo', async (id) => {
    const original = id === 'f1' ? frame.name : image.name
    doubleClick(id)
    expect(document.activeElement).toBe(input())
    expect(input().value).toBe(original)
    expect(input().selectionStart).toBe(0)
    expect(input().selectionEnd).toBe(original.length)
    input().value = '  New name  '
    press('Enter')
    expect(input()).toBeNull()
    expect(row(id).textContent).toContain('New name')
    expect(updateFrame).toHaveBeenCalledExactlyOnceWith(id, { name: 'New name' })
    expect(useStore.getState().flyTo).toBeNull()
    expect(reachedWindow).not.toHaveBeenCalled()
    await act(async () => undo())
    expect(row(id).textContent).toContain(original)
    await act(async () => redo())
    expect(row(id).textContent).toContain('New name')
  })

  it.each(['f1', 'image'])('keeps focus in the editor after choosing Rename for %s', async (id) => {
    const rename = await openMenu(id)
    expect(rename).toBeDefined()
    await act(async () => rename.click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(input()).not.toBeNull()
    expect(document.activeElement).toBe(input())
    input().value = 'From menu'
    await act(async () => input().blur())
    expect(updateFrame).toHaveBeenCalledExactlyOnceWith(id, { name: 'From menu' })
  })

  it('cancels on Escape and ignores empty or unchanged names', () => {
    doubleClick('f1')
    input().value = 'Cancelled'
    press('Escape')
    expect(input()).toBeNull()
    expect(row('f1').textContent).toContain('Frame')
    for (const value of ['   ', 'Frame']) {
      doubleClick('f1')
      input().value = value
      press('Enter')
    }
    expect(updateFrame).not.toHaveBeenCalled()
  })

  it('isolates editing gestures and leaves IME confirmation to the input', () => {
    doubleClick('f1')
    input().value = 'Draft'
    press('Delete')
    press('ArrowDown')
    press('Enter', true)
    act(() => input().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
    act(() => input().click())
    expect(input()).not.toBeNull()
    expect(useStore.getState().selectedId).toBeNull()
    expect(reachedWindow).not.toHaveBeenCalled()
    expect(updateFrame).not.toHaveBeenCalled()
    press('Escape')
  })

  it.each(['view', 'comment'] as const)('does not rename on a %s link', async (role) => {
    act(() => useStore.getState().setRole(role))
    doubleClick('f1')
    doubleClick('image')
    expect(input()).toBeNull()
    expect(await openMenu('f1')).toBeUndefined()
  })

  it('disables renaming locked frames and images', async () => {
    act(() => {
      useStore.getState().patchFrameLocal('f1', { locked: true })
      useStore.getState().patchFrameLocal('image', {
        html: image.html.replace('<img ', '<img data-doop-locked="true" '),
      })
    })
    doubleClick('f1')
    doubleClick('image')
    expect(input()).toBeNull()
    expect((await openMenu('f1')).getAttribute('aria-disabled')).toBe('true')
  })

  it('rolls back a failed save and removes its undo entry', async () => {
    updateFrame.mockRejectedValueOnce(new Error('offline'))
    doubleClick('f1')
    input().value = 'Failed'
    press('Enter')
    await act(async () => {
      await Promise.resolve()
    })
    expect(row('f1').textContent).toContain('Frame')
    expect(useStore.getState().notice?.text).toBe('Couldn’t rename “Frame”')
    await act(async () => undo())
    expect(updateFrame).toHaveBeenCalledTimes(1)
  })

  const nestedHtml =
    '<body><div id="box"><p id="text">Visible text</p><img id="photo" src="/photo.png" alt="Original alt" /></div></body>'
  function showLayers(html = nestedHtml) {
    act(() => {
      useStore.getState().patchFrameLocal('f1', { html })
      useStore.getState().pickElement({ frameId: 'f1', selector: '#text' })
    })
  }
  function savedDocument() {
    return new DOMParser().parseFromString(
      useStore.getState().canvas!.frames.find((f) => f.id === 'f1')!.html,
      'text/html',
    )
  }

  it.each(['#photo', '#text', '#box'])(
    'renames nested %s without changing content and supports undo',
    async (selector) => {
      showLayers()
      const key = `f1|${selector}`
      doubleClick(key)
      input().value = 'Custom label'
      press('Enter')
      expect(row(key).textContent).toContain('Custom label')
      expect(savedDocument().querySelector(selector)?.getAttribute('data-doop-name')).toBe('Custom label')
      expect(savedDocument().querySelector('#text')?.textContent).toBe('Visible text')
      expect(savedDocument().querySelector('#photo')?.getAttribute('alt')).toBe('Original alt')
      expect(savedDocument().querySelector('#photo')?.getAttribute('src')).toBe('/photo.png')
      expect(requestFrame).toHaveBeenCalledWith('f1', 'doop:rename', {
        selector,
        name: 'Custom label',
        elementId: expect.stringMatching(/^[a-z0-9]{6}$/),
      })
      /* the rename stamps the element's id, which is what undo and redo find it by */
      const elementId = savedDocument().querySelector(selector)?.getAttribute('data-doop-id')
      expect(elementId).toMatch(/^[a-z0-9]{6}$/)
      expect(updateFrame.mock.calls[0]?.[1]).toHaveProperty('html')
      await act(async () => undo())
      expect(savedDocument().querySelector(selector)?.hasAttribute('data-doop-name')).toBe(false)
      expect(savedDocument().querySelector(selector)?.getAttribute('data-doop-id')).toBe(elementId)
      await act(async () => redo())
      expect(row(key).textContent).toContain('Custom label')

      const rename = await openMenu(key)
      await act(async () => rename.click())
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
      expect(document.activeElement).toBe(input())
      expect(input().value).toBe('Custom label')
      input().value = 'From nested menu'
      await act(async () => input().blur())
      expect(row(key).textContent).toContain('From nested menu')
    },
  )

  it('undoes a rename on the element it named after a sibling lands before it', async () => {
    showLayers('<body><p>First</p><p>Second</p></body>')
    doubleClick('f1|body:nth-of-type(1) > p:nth-of-type(1)')
    input().value = 'Lead'
    press('Enter')
    const first = savedDocument().querySelector('p[data-doop-name="Lead"]')!
    const id = first.getAttribute('data-doop-id')!
    /* a teammate's paragraph arrives in front of the named one */
    act(() => {
      useStore.getState().patchFrameLocal('f1', {
        html: `<body><p>Newer</p><p data-doop-name="Lead" data-doop-id="${id}">First</p><p>Second</p></body>`,
      })
    })
    await act(async () => undo())
    const paragraphs = [...savedDocument().querySelectorAll('p')]
    expect(paragraphs.map((p) => p.textContent)).toEqual(['Newer', 'First', 'Second'])
    expect(paragraphs.map((p) => p.getAttribute('data-doop-name'))).toEqual([null, null, null])
    expect(requestFrame).toHaveBeenLastCalledWith('f1', 'doop:rename', {
      selector: `[data-doop-id="${id}"]`,
      name: null,
    })
    await act(async () => redo())
    expect(savedDocument().querySelector(`[data-doop-id="${id}"]`)?.getAttribute('data-doop-name')).toBe('Lead')
    expect(savedDocument().querySelector('p')?.hasAttribute('data-doop-name')).toBe(false)
  })

  it('refuses the undo when the renamed layer is gone rather than renaming its neighbour', async () => {
    showLayers('<body><p>First</p><p>Second</p></body>')
    doubleClick('f1|body:nth-of-type(1) > p:nth-of-type(1)')
    input().value = 'Lead'
    press('Enter')
    expect(updateFrame).toHaveBeenCalledTimes(1)
    /* a teammate deletes the named paragraph */
    act(() => useStore.getState().patchFrameLocal('f1', { html: '<body><p>Second</p></body>' }))
    await act(async () => undo())
    expect(updateFrame).toHaveBeenCalledTimes(1)
    const paragraphs = [...savedDocument().querySelectorAll('p')]
    expect(paragraphs.map((p) => p.textContent)).toEqual(['Second'])
    expect(paragraphs[0]?.hasAttribute('data-doop-name')).toBe(false)
    expect(paragraphs[0]?.hasAttribute('data-doop-id')).toBe(false)
  })

  it('keeps the id an element already wears instead of stamping another', async () => {
    showLayers('<body><p data-doop-id="abc123">Hello</p></body>')
    doubleClick('f1|body:nth-of-type(1) > p:nth-of-type(1)')
    input().value = 'Greeting'
    press('Enter')
    expect(savedDocument().querySelectorAll('[data-doop-id]')).toHaveLength(1)
    expect(savedDocument().querySelector('p')?.getAttribute('data-doop-id')).toBe('abc123')
    expect(requestFrame).toHaveBeenLastCalledWith('f1', 'doop:rename', {
      selector: 'body:nth-of-type(1) > p:nth-of-type(1)',
      name: 'Greeting',
    })
  })

  it('does not rename a child of a locked layer', async () => {
    showLayers(nestedHtml.replace('id="box"', 'id="box" data-doop-locked="true"'))
    doubleClick('f1|#photo')
    expect(input()).toBeNull()
    expect((await openMenu('f1|#photo')).getAttribute('aria-disabled')).toBe('true')
    expect(updateFrame).not.toHaveBeenCalled()
  })

  it('rolls back a failed layer rename in the saved and live documents', async () => {
    showLayers()
    updateFrame.mockRejectedValueOnce(new Error('offline'))
    doubleClick('f1|#photo')
    input().value = 'Failed image'
    press('Enter')
    await act(async () => {
      await Promise.resolve()
    })
    expect(savedDocument().querySelector('#photo')?.hasAttribute('data-doop-name')).toBe(false)
    expect(requestFrame).toHaveBeenLastCalledWith('f1', 'doop:rename', {
      selector: '#photo',
      name: null,
      elementId: null,
    })
    expect(savedDocument().querySelector('#photo')?.hasAttribute('data-doop-id')).toBe(false)
    await act(async () => undo())
    expect(updateFrame).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['frame', false],
    ['layer', false],
    ['frame', true],
    ['layer', true],
  ] as const)(
    'uses the confirmed name after an overlapping %s save fails (second succeeds: %s)',
    async (kind, secondSucceeds) => {
      showLayers()
      let rejectFirst!: (error: Error) => void
      let finishSecond!: () => void
      updateFrame.mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject
          }),
      )
      updateFrame.mockImplementationOnce(
        () =>
          new Promise<void>((resolve, reject) => {
            finishSecond = () => (secondSucceeds ? resolve() : reject(new Error('offline again')))
          }),
      )
      const rename = (name: string) => (kind === 'frame' ? renameFrame('f1', name) : renameLayer('f1', '#photo', name))
      const currentName = () =>
        kind === 'frame'
          ? useStore.getState().canvas!.frames.find((f) => f.id === 'f1')!.name
          : savedDocument().querySelector('#photo')?.getAttribute('data-doop-name')
      act(() => {
        rename('A')
        rename('B')
      })
      expect(updateFrame).toHaveBeenCalledTimes(1)
      await act(async () => rejectFirst(new Error('offline')))
      expect(updateFrame).toHaveBeenCalledTimes(2)
      expect(currentName()).toBe('B')
      await act(async () => finishSecond())
      expect(currentName()).toBe(secondSucceeds ? 'B' : kind === 'frame' ? 'Frame' : null)
      await act(async () => undo())
      expect(currentName()).toBe(kind === 'frame' ? 'Frame' : null)
      expect(updateFrame).toHaveBeenCalledTimes(secondSucceeds ? 3 : 2)
    },
  )

  it.each(['<body><p>Second</p></body>', '<body><p>Second</p><p>First</p></body>'])(
    'cancels a queued positional rename after the document changes to %s',
    async (html) => {
      let finishFirst!: () => void
      updateFrame.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirst = resolve
          }),
      )
      act(() => {
        useStore.getState().patchFrameLocal('f1', { html: '<body><p>First</p><p>Second</p></body>' })
        renameFrame('f1', 'Pending frame name')
        renameLayer('f1', 'body:nth-of-type(1) > p:nth-of-type(1)', 'Name for first paragraph')
        useStore.getState().patchFrameLocal('f1', { html })
      })
      await act(async () => finishFirst())
      expect(updateFrame).toHaveBeenCalledTimes(1)
      expect(savedDocument().querySelector('[data-doop-name]')).toBeNull()
      expect(savedDocument().querySelector('p')?.textContent).toBe('Second')
      expect(useStore.getState().notice?.text).toBe('The layer changed before it could be renamed. Try again.')
    },
  )

  it('allows queued renames on different layers when only names have changed', async () => {
    showLayers()
    let finishFirst!: () => void
    updateFrame.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve
        }),
    )
    act(() => {
      renameLayer('f1', '#text', 'Caption')
      renameLayer('f1', '#photo', 'Photo')
    })
    await act(async () => finishFirst())
    expect(updateFrame).toHaveBeenCalledTimes(2)
    expect(savedDocument().querySelector('#text')?.getAttribute('data-doop-name')).toBe('Caption')
    expect(savedDocument().querySelector('#photo')?.getAttribute('data-doop-name')).toBe('Photo')
  })
})
