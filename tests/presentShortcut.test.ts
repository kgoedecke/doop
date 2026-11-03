// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { Canvas, Frame } from '../shared/types'

const { isPresentShortcut } = await import('../src/lib/keys')
const { presentStartFrame } = await import('../src/lib/present')

const chord = (over: Partial<Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>>) => ({
  key: 'Enter',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
})

function frame(id: string, y: number, over: Partial<Frame> = {}): Frame {
  return { id, name: id, x: 0, y, width: 100, height: 100, html: '', pageId: 'p1', ...over } as Frame
}

describe('⌘⌥↩ present from frame', () => {
  it('matches ⌘⌥↩ on Mac and Ctrl+Alt+Enter elsewhere', () => {
    expect(isPresentShortcut(chord({ metaKey: true, altKey: true }))).toBe(true)
    expect(isPresentShortcut(chord({ ctrlKey: true, altKey: true }))).toBe(true)
    /* Enter alone, ⌘↩ and ⌥↩ mean other things; Shift is not part of the chord */
    expect(isPresentShortcut(chord({}))).toBe(false)
    expect(isPresentShortcut(chord({ metaKey: true }))).toBe(false)
    expect(isPresentShortcut(chord({ altKey: true }))).toBe(false)
    expect(isPresentShortcut(chord({ metaKey: true, altKey: true, shiftKey: true }))).toBe(false)
    expect(isPresentShortcut(chord({ key: 'Return', metaKey: true, altKey: true }))).toBe(false)
  })

  it('presents the selected frame, else the page flow start, else nothing', () => {
    const canvas = {
      id: 'c1',
      name: 'Canvas',
      pages: [{ id: 'p1', name: 'Page', startFrameId: 'b' }],
      frames: [frame('a', 0), frame('b', 50)],
    } as unknown as Canvas
    expect(presentStartFrame(canvas, 'a', 'p1')).toBe('a')
    expect(presentStartFrame(canvas, null, 'p1')).toBe('b')
    expect(presentStartFrame(null, null, 'p1')).toBe(null)
    expect(presentStartFrame({ ...canvas, frames: [] }, null, 'p1')).toBe(null)
  })
})
