// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Canvas } from '../shared/types'

const { isHideUiShortcut } = await import('../src/lib/keys')
const { canHideUi, hideUiHinted } = await import('../src/lib/hideUi')
const { useStore } = await import('../src/lib/store')

describe('⌘. hide UI', () => {
  it('matches the bare ⌘. / Ctrl+. chord only', () => {
    expect(isHideUiShortcut({ key: '.', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe(true)
    expect(isHideUiShortcut({ key: '.', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false })).toBe(true)
    /* a plain period is typing; ⌘⇧. and ⌥ chords belong to the browser */
    expect(isHideUiShortcut({ key: '.', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBe(false)
    expect(isHideUiShortcut({ key: '.', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true })).toBe(false)
    expect(isHideUiShortcut({ key: '.', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false })).toBe(false)
    expect(isHideUiShortcut({ key: ',', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe(false)
  })

  it('toggles the flag without touching what the panels had open', () => {
    useStore.setState({ uiHidden: false, layersOpen: true, inspectorOpen: true, elementPanelOpen: false })
    useStore.getState().toggleUiHidden()
    expect(useStore.getState().uiHidden).toBe(true)
    expect(useStore.getState().layersOpen).toBe(true)
    expect(useStore.getState().inspectorOpen).toBe(true)
    useStore.getState().toggleUiHidden()
    expect(useStore.getState().uiHidden).toBe(false)
    expect(useStore.getState().layersOpen).toBe(true)
    expect(useStore.getState().inspectorOpen).toBe(true)
  })

  it('ends when the canvas is left, so the next one never opens hidden', () => {
    const canvas = { id: 'c1', name: 'Canvas', frames: [] } as unknown as Canvas
    useStore.getState().setCanvas(canvas)
    useStore.setState({ uiHidden: true })
    /* a re-join of the same canvas (reconnect, a server patch) keeps it */
    useStore.getState().setCanvas({ ...canvas })
    expect(useStore.getState().uiHidden).toBe(true)
    /* CanvasPage's cleanup on unmount / id change */
    useStore.getState().setCanvas(null)
    expect(useStore.getState().uiHidden).toBe(false)
  })

  it('acts only over the canvas view, outside PresentMode', () => {
    expect(canHideUi({ view: 'canvas', presenting: false })).toBe(true)
    /* the board has no canvas chrome; PresentMode keeps its own controls */
    expect(canHideUi({ view: 'board', presenting: false })).toBe(false)
    expect(canHideUi({ view: 'canvas', presenting: true })).toBe(false)
  })

  describe('the "UI hidden" hint', () => {
    beforeEach(() => localStorage.clear())

    it('shows on the first hide in a browser and never again', () => {
      expect(hideUiHinted()).toBe(false)
      expect(hideUiHinted()).toBe(true)
      expect(hideUiHinted()).toBe(true)
    })
  })
})
