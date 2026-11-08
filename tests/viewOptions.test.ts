// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_VIEW_OPTIONS,
  parseZoomPercent,
  readViewOptions,
  viewOptionForKey,
  writeViewOptions,
} from '../src/lib/viewOptions'

/**
 * What the canvas draws over the frames (pixel grid, other people's cursors,
 * comment pins): switched by shortcut or from the zoom pill's menu and kept per
 * browser. The menu also takes a typed zoom level.
 */

const press = (over: Partial<KeyboardEvent>) =>
  ({ code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over }) as KeyboardEvent

describe('viewOptionForKey', () => {
  it("maps ⇧' / ⇧C / ⌘⌥\\ (Ctrl+Alt+\\) by code", () => {
    expect(viewOptionForKey(press({ code: 'Quote', shiftKey: true }))).toBe('pixelGrid')
    expect(viewOptionForKey(press({ code: 'KeyC', shiftKey: true }))).toBe('comments')
    expect(viewOptionForKey(press({ code: 'Backslash', metaKey: true, altKey: true }))).toBe('cursors')
    expect(viewOptionForKey(press({ code: 'Backslash', ctrlKey: true, altKey: true }))).toBe('cursors')
  })

  it('leaves the bare keys and other chords alone', () => {
    /* C alone is the Comment tool, ⌘C is copy */
    expect(viewOptionForKey(press({ code: 'KeyC' }))).toBeNull()
    expect(viewOptionForKey(press({ code: 'KeyC', metaKey: true }))).toBeNull()
    expect(viewOptionForKey(press({ code: 'KeyC', shiftKey: true, metaKey: true }))).toBeNull()
    expect(viewOptionForKey(press({ code: 'Quote' }))).toBeNull()
    expect(viewOptionForKey(press({ code: 'Backslash', metaKey: true }))).toBeNull()
    expect(viewOptionForKey(press({ code: 'Backslash', metaKey: true, altKey: true, shiftKey: true }))).toBeNull()
  })
})

describe('readViewOptions / writeViewOptions', () => {
  afterEach(() => localStorage.clear())

  it('starts with everything shown', () => {
    expect(readViewOptions()).toEqual(DEFAULT_VIEW_OPTIONS)
  })

  it('round-trips a choice', () => {
    writeViewOptions({ pixelGrid: false, cursors: true, comments: false })
    expect(readViewOptions()).toEqual({ pixelGrid: false, cursors: true, comments: false })
  })

  it('falls back field by field on a damaged value', () => {
    localStorage.setItem('doop:view-options', '{"cursors":false,"comments":"no"}')
    expect(readViewOptions()).toEqual({ pixelGrid: true, cursors: false, comments: true })
    localStorage.setItem('doop:view-options', 'not json')
    expect(readViewOptions()).toEqual(DEFAULT_VIEW_OPTIONS)
  })
})

describe('parseZoomPercent', () => {
  it('reads a percentage with or without the sign', () => {
    expect(parseZoomPercent('150')).toBe(1.5)
    expect(parseZoomPercent(' 50 % ')).toBe(0.5)
    expect(parseZoomPercent('12.5%')).toBe(0.125)
  })

  it('refuses anything else', () => {
    for (const text of ['', '%', 'abc', '0', '-50', '1e3', '50%%']) expect(parseZoomPercent(text)).toBeNull()
  })
})
