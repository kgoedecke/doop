// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { TOOLS, resolvePointerAction, toolForKey, toolForShortcut, type PointerContext } from '../src/lib/tools'

/**
 * The bottom toolbar's tools decide what a pointer-down means. Select is the
 * canvas as it always was; Hand pans wherever the press lands; Comment turns
 * a press on a frame into a comment on the element under it and a press on
 * empty canvas into a comment pinned to that point. The space bar is a
 * temporary Hand in every tool.
 */

const mouse = (over: Partial<PointerContext>): PointerContext => ({
  tool: 'select',
  target: 'background',
  button: 0,
  pointerType: 'mouse',
  spaceHeld: false,
  ...over,
})

describe('resolvePointerAction', () => {
  it('Select: marquee on the background, drag on a frame', () => {
    expect(resolvePointerAction(mouse({ target: 'background' }))).toBe('marquee')
    expect(resolvePointerAction(mouse({ target: 'frame' }))).toBe('frame-drag')
  })

  it('Hand: pans wherever the press lands, frames included', () => {
    expect(resolvePointerAction(mouse({ tool: 'hand', target: 'background' }))).toBe('pan')
    expect(resolvePointerAction(mouse({ tool: 'hand', target: 'frame' }))).toBe('pan')
  })

  it('Zoom: zooms wherever the press lands, frames included', () => {
    expect(resolvePointerAction(mouse({ tool: 'zoom', target: 'background' }))).toBe('zoom')
    expect(resolvePointerAction(mouse({ tool: 'zoom', target: 'frame' }))).toBe('zoom')
    expect(resolvePointerAction(mouse({ tool: 'zoom', target: 'background', pointerType: 'touch' }))).toBe('zoom')
  })

  it('Comment: a press on a frame starts an element comment, one on the background a canvas comment', () => {
    expect(resolvePointerAction(mouse({ tool: 'comment', target: 'frame' }))).toBe('comment')
    expect(resolvePointerAction(mouse({ tool: 'comment', target: 'background' }))).toBe('comment-canvas')
    expect(resolvePointerAction(mouse({ tool: 'comment', target: 'background', pointerType: 'pen' }))).toBe(
      'comment-canvas',
    )
  })

  it('space held is a temporary Hand in every tool', () => {
    for (const { id: tool } of TOOLS) {
      expect(resolvePointerAction(mouse({ tool, target: 'frame', spaceHeld: true }))).toBe('pan')
      expect(resolvePointerAction(mouse({ tool, target: 'background', spaceHeld: true }))).toBe('pan')
    }
  })

  it('the middle button pans in every tool; other buttons are not ours', () => {
    for (const { id: tool } of TOOLS) {
      expect(resolvePointerAction(mouse({ tool, target: 'frame', button: 1 }))).toBe('pan')
      expect(resolvePointerAction(mouse({ tool, target: 'frame', button: 2 }))).toBe('none')
    }
  })

  it('a finger on the background pans (phones have no space bar), on a frame it drags', () => {
    expect(resolvePointerAction(mouse({ pointerType: 'touch', target: 'background' }))).toBe('pan')
    expect(resolvePointerAction(mouse({ pointerType: 'touch', target: 'frame' }))).toBe('frame-drag')
    /* the Comment tool is the exception: a tap is how a phone places a canvas
       comment, and the stage pans a finger that moves on its own */
    expect(resolvePointerAction(mouse({ tool: 'comment', pointerType: 'touch', target: 'background' }))).toBe(
      'comment-canvas',
    )
  })

  it('drawing tools draw on both frames and background, including touch and pen', () => {
    for (const tool of ['rectangle', 'circle', 'path', 'text', 'frame'] as const) {
      for (const pointerType of ['mouse', 'touch', 'pen']) {
        expect(resolvePointerAction(mouse({ tool, pointerType, target: 'background' }))).toBe('draw')
        expect(resolvePointerAction(mouse({ tool, pointerType, target: 'frame' }))).toBe('draw')
      }
    }
  })
})

describe('toolForKey', () => {
  it('maps V / H / C to their tools, either case', () => {
    expect(toolForKey('v')).toBe('select')
    expect(toolForKey('H')).toBe('hand')
    expect(toolForKey('c')).toBe('comment')
    expect(toolForKey('z')).toBe('zoom')
  })

  it('knows nothing about other keys', () => {
    expect(toolForKey('q')).toBeNull()
    expect(toolForKey('Escape')).toBeNull()
  })

  it('maps the drawing shortcuts without conflicts', () => {
    expect(['f', 'R', 'o', 'P', 't'].map(toolForKey)).toEqual(['frame', 'rectangle', 'circle', 'path', 'text'])
    expect(new Set(TOOLS.map((t) => t.key)).size).toBe(TOOLS.length)
  })
})

describe('toolForShortcut', () => {
  const press = (key: string, code: string, extra: KeyboardEventInit = {}) =>
    new KeyboardEvent('keydown', { key, code, ...extra })

  it.each([
    ['с', 'KeyC', 'comment'],
    ['c', 'KeyC', 'comment'],
    ['м', 'KeyV', 'select'],
    ['р', 'KeyH', 'hand'],
    ['я', 'KeyZ', 'zoom'],
  ])('maps %s on %s to %s', (key, code, tool) => {
    expect(toolForShortcut(press(key, code))).toBe(tool)
  })

  it('uses the physical key when the layout produces a different shortcut character', () => {
    expect(toolForShortcut(press('c', 'KeyV'))).toBe('select')
    expect(toolForShortcut(press('c', 'IntlBackslash'))).toBeNull()
    expect(toolForShortcut(press('с', 'KeyC', { shiftKey: true }))).toBeNull()
    expect(toolForShortcut(press('с', 'KeyC', { ctrlKey: true }))).toBeNull()
  })

  it.each(['input', 'textarea', 'select', 'div'])('leaves Cyrillic typing in a %s alone', (tag) => {
    const field = document.createElement(tag)
    if (tag === 'div') field.contentEditable = 'true'
    const resolveTool = vi.fn(toolForShortcut)
    field.addEventListener('keydown', resolveTool)
    expect(field.dispatchEvent(press('с', 'KeyC', { cancelable: true }))).toBe(true)
    expect(resolveTool).toHaveReturnedWith(null)
  })
})
