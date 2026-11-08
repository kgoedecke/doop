// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { ACTIONS, dispatchActionKey, setActionHost } = await import('../src/lib/actions/registry')
const { TOOLS } = await import('../src/lib/tools')
const { boundOn } = await import('../src/lib/actions/chords')
const { useStore } = await import('../src/lib/store')
type ActionHost = import('../src/lib/actions/registry').ActionHost
type Chord = import('../src/lib/actions/chords').Chord

/* off a Mac, Ctrl and the mod key are one key */
function chordId(c: Chord, mac: boolean) {
  const ctrl = mac ? c.ctrl : false
  const mod = mac ? c.mod : c.mod || c.ctrl
  return [ctrl && 'ctrl', c.alt && 'alt', c.shift && 'shift', mod && 'mod', c.code ?? c.key?.toLowerCase()]
    .filter(Boolean)
    .join('+')
}

function keyEvent(key: string, mods: Partial<KeyboardEvent> = {}, code = '') {
  return {
    key,
    code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    preventDefault: vi.fn(),
    ...mods,
  }
}

function stubHost(): ActionHost {
  return {
    canvasId: 'c1',
    guest: false,
    presenting: false,
    hideUiActive: true,
    agentsOpen: false,
    openPalette: vi.fn(),
    openAgent: vi.fn(),
    openShortcuts: vi.fn(),
    openFind: vi.fn(),
    findStep: vi.fn(),
    openExport: vi.fn(),
    openImport: vi.fn(),
    openVersionHistory: vi.fn(),
    openLink: vi.fn(),
    placeImage: vi.fn(),
    newCanvas: vi.fn(),
    duplicateCanvas: vi.fn(),
    present: vi.fn(),
    toggleHideUi: vi.fn(),
    toggleAgents: vi.fn(),
  }
}

describe('the action list', () => {
  it('names every action once', () => {
    const ids = ACTIONS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each([true, false])('binds no chord twice, nor a tool’s key (Mac: %s)', (mac) => {
    const seen = new Map<string, string>()
    for (const tool of TOOLS) seen.set(tool.key.toLowerCase(), `tool ${tool.id}`)
    for (const action of ACTIONS) {
      for (const chord of (action.keys ?? []).filter((c) => boundOn(c, mac))) {
        const id = chordId(chord, mac)
        expect(seen.get(id), `${action.id} takes ${id}`).toBeUndefined()
        seen.set(id, action.id)
      }
    }
  })
})

describe('dispatchActionKey', () => {
  let host: ActionHost
  beforeEach(() => {
    host = stubHost()
    setActionHost(host)
    useStore.setState({ canvas: null, role: 'edit' } as never)
  })
  afterEach(() => setActionHost(null))

  it('opens the palette on ⌘K, even from a field', () => {
    const e = keyEvent('k', { metaKey: true })
    expect(dispatchActionKey(e, true, true)).toBe(true)
    expect(host.openPalette).toHaveBeenCalled()
    expect(e.preventDefault).toHaveBeenCalled()
  })

  it('opens the shortcuts sheet on ⌃⇧?', () => {
    expect(dispatchActionKey(keyEvent('?', { ctrlKey: true, shiftKey: true }, 'Slash'), false, true)).toBe(true)
    expect(host.openShortcuts).toHaveBeenCalled()
  })

  it('leaves keys alone while presenting', () => {
    setActionHost({ ...host, presenting: true })
    expect(dispatchActionKey(keyEvent('k', { metaKey: true }), false, true)).toBe(false)
  })

  it('keeps a bare key out of fields', () => {
    expect(dispatchActionKey(keyEvent('n'), true, true)).toBe(false)
  })

  it("toggles the pixel grid on ⇧' by code", () => {
    const before = useStore.getState().viewOptions.pixelGrid
    dispatchActionKey(keyEvent('"', { shiftKey: true }, 'Quote'), false, true)
    expect(useStore.getState().viewOptions.pixelGrid).toBe(!before)
  })

  it('toggles the view on ⇧C and ⌘Y', () => {
    const before = useStore.getState().viewOptions.comments
    dispatchActionKey(keyEvent('C', { shiftKey: true }), false, true)
    expect(useStore.getState().viewOptions.comments).toBe(!before)
    dispatchActionKey(keyEvent('y', { metaKey: true }), false, true)
    expect(useStore.getState().outlines).toBe(true)
  })

  it('swallows a held key for a command that must not repeat', () => {
    const e = keyEvent('k', { metaKey: true, repeat: true })
    expect(dispatchActionKey(e, false, true)).toBe(true)
    expect(host.openPalette).not.toHaveBeenCalled()
  })

  it('leaves a chord to the browser when its command has nothing to act on', () => {
    /* ⌘G with nothing picked: the group command is disabled */
    const e = keyEvent('g', { metaKey: true }, 'KeyG')
    expect(dispatchActionKey(e, false, true)).toBe(false)
    expect(e.preventDefault).not.toHaveBeenCalled()
  })
})
