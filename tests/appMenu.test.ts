// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { ACTIONS, MENUS, setActionHost } = await import('../src/lib/actions/registry')
const { firstChord } = await import('../src/lib/actions/chords')
const { hasAppMenu, initAppMenu, nativeAccelerator, nativeMenus, nativeStates, runNativeItem, syncAppMenu } =
  await import('../src/lib/appMenu')
const { useStore } = await import('../src/lib/store')
type ActionHost = import('../src/lib/actions/registry').ActionHost
type NativeMenuItem = import('../src/lib/appMenu').NativeMenuItem

function stubHost(overrides: Partial<ActionHost> = {}): ActionHost {
  return {
    canvasId: 'c1',
    guest: false,
    presenting: false,
    hideUiActive: true,
    agentsOpen: false,
    openPalette: vi.fn(),
    openAgent: vi.fn(),
    openShortcuts: vi.fn(),
    goToFiles: vi.fn(),
    openDocs: vi.fn(),
    contactSupport: vi.fn(),
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
    ...overrides,
  }
}

const items = (menu: { items: (NativeMenuItem | null)[] }) => menu.items.filter((i) => i !== null)

afterEach(() => {
  setActionHost(null)
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('nativeAccelerator', () => {
  it('names the physical key with the modifiers in the system order', () => {
    expect(nativeAccelerator({ key: 'g', mod: true, alt: true, code: 'KeyG' })).toBe('Alt+Cmd+KeyG')
    expect(nativeAccelerator({ key: 'g', mod: true, shift: true })).toBe('Shift+Cmd+KeyG')
    expect(nativeAccelerator({ code: 'KeyT', alt: true, ctrl: true })).toBe('Ctrl+Alt+KeyT')
    expect(nativeAccelerator({ key: 'a', shift: true })).toBe('Shift+KeyA')
  })

  it('turns digits, punctuation and named keys into codes', () => {
    expect(nativeAccelerator({ key: '0', mod: true })).toBe('Cmd+Digit0')
    expect(nativeAccelerator({ key: ']' })).toBe('BracketRight')
    expect(nativeAccelerator({ key: '=', mod: true })).toBe('Cmd+Equal')
    expect(nativeAccelerator({ key: '.', mod: true })).toBe('Cmd+Period')
    expect(nativeAccelerator({ key: 'PageUp' })).toBe('PageUp')
    expect(nativeAccelerator({ key: 'Enter', mod: true, alt: true })).toBe('Alt+Cmd+Enter')
  })

  it('gives up on a key it has no name for', () => {
    expect(nativeAccelerator({ key: '?', shift: true })).toBeNull()
  })

  it('names every chord a menu row shows on a Mac', () => {
    const unnamed = ACTIONS.filter((a) => {
      const chord = firstChord(a.keys, true)
      return chord && !nativeAccelerator(chord)
    }).map((a) => a.id)
    expect(unnamed).toEqual([])
  })
})

describe('nativeMenus', () => {
  it('lists the registry menus in order, a separator between sections', () => {
    const menus = nativeMenus()
    expect(menus.map((m) => m.id)).toEqual(MENUS.map((m) => m.id))
    const object = menus.find((m) => m.id === 'object')!
    const sections = new Set(ACTIONS.filter((a) => a.menu === 'object').map((a) => a.section))
    expect(object.items.filter((i) => i === null)).toHaveLength(sections.size - 1)
    expect(object.items[0]).toEqual({
      id: 'frame-selection',
      label: 'Frame selection',
      accelerator: 'Alt+Cmd+KeyG',
      checkable: false,
    })
  })

  it('leaves Undo and Redo to the system items and opens Help with the palette', () => {
    const [edit, help] = ['edit', 'help'].map((id) => nativeMenus().find((m) => m.id === id)!)
    expect(items(edit!).map((i) => i.id)).not.toContain('undo')
    expect(items(edit!).map((i) => i.id)).not.toContain('redo')
    expect(help!.items.map((i) => i?.id ?? null)).toEqual([
      'palette',
      null,
      'shortcuts',
      null,
      'docs',
      'customer-support',
    ])
  })

  it('marks toggles as checkable', () => {
    const view = nativeMenus().find((m) => m.id === 'view')!
    expect(items(view).find((i) => i.id === 'rulers')).toMatchObject({ checkable: true, accelerator: 'Shift+KeyR' })
    expect(items(view).find((i) => i.id === 'zoom-in')).toMatchObject({ checkable: false })
  })
})

describe('nativeStates', () => {
  it('disables everything while no canvas is open', () => {
    expect(nativeStates().every(([, enabled, checked]) => !enabled && checked !== true)).toBe(true)
  })

  it('reports what a canvas allows and which toggles are on', () => {
    setActionHost(stubHost())
    useStore.setState({ rulers: true })
    const state = new Map(nativeStates().map(([id, ...rest]) => [id, rest]))
    expect(state.get('palette')).toEqual([true, null])
    expect(state.get('rulers')).toEqual([true, true])
    expect(state.has('undo')).toBe(false)
  })
})

describe('runNativeItem', () => {
  it('runs a clicked item', () => {
    const host = stubHost()
    setActionHost(host)
    runNativeItem('shortcuts', false)
    expect(host.openShortcuts).toHaveBeenCalledOnce()
  })

  it('keeps the canvas keyboard rules for a key equivalent', () => {
    const host = stubHost()
    setActionHost(host)
    const field = document.createElement('input')
    document.body.append(field)
    field.focus()
    runNativeItem('shortcuts', true)
    expect(host.openShortcuts).not.toHaveBeenCalled()
    /* a global chord acts from a field */
    runNativeItem('palette', true)
    expect(host.openPalette).toHaveBeenCalledOnce()
    /* a key that reached the menu from inside a frame was never the page's */
    const frame = document.createElement('iframe')
    document.body.append(frame)
    frame.focus()
    runNativeItem('shortcuts', true)
    expect(host.openShortcuts).not.toHaveBeenCalled()
    field.blur()
    frame.remove()
    runNativeItem('shortcuts', true)
    expect(host.openShortcuts).toHaveBeenCalledOnce()
  })

  it('ignores keys while presenting and keys another handler owns', () => {
    const presenting = stubHost({ presenting: true })
    setActionHost(presenting)
    runNativeItem('shortcuts', true)
    expect(presenting.openShortcuts).not.toHaveBeenCalled()
    /* ⌫ and Esc are the canvas page's own, with rules the registry does not know */
    const selectNone = ACTIONS.find((a) => a.id === 'select-none')!
    vi.spyOn(selectNone, 'enabled').mockReturnValue(true)
    const run = vi.spyOn(selectNone, 'run')
    setActionHost(stubHost())
    runNativeItem('select-none', true)
    expect(run).not.toHaveBeenCalled()
    runNativeItem('select-none', false)
    expect(run).toHaveBeenCalledOnce()
  })
})

describe('the shell bridge', () => {
  let invoke: ReturnType<typeof vi.fn>
  let listen: ReturnType<typeof vi.fn>
  beforeEach(() => {
    invoke = vi.fn(() => Promise.resolve())
    listen = vi.fn(() => Promise.resolve())
    vi.stubGlobal('__TAURI__', { core: { invoke }, event: { listen } })
  })

  it('stays out of a shell without the menu bar', () => {
    expect(hasAppMenu()).toBe(false)
    initAppMenu()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('sends the menus, then only the items whose state moved', () => {
    vi.stubGlobal('__DOOP_APP_MENU__', true)
    initAppMenu()
    expect(invoke.mock.calls[0]).toEqual(['app_menu_set', { menus: nativeMenus() }])
    expect(invoke.mock.calls[1]).toEqual(['app_menu_state', { items: nativeStates() }])
    syncAppMenu()
    expect(invoke).toHaveBeenCalledTimes(2)
    setActionHost(stubHost())
    syncAppMenu()
    const sent = invoke.mock.calls[2] as [string, { items: [string, boolean, boolean | null][] }]
    expect(sent[0]).toBe('app_menu_state')
    expect(sent[1].items).toContainEqual(['shortcuts', true, null])
    expect(sent[1].items.length).toBeLessThan(nativeStates().length)
  })

  it('runs what the menu picks', () => {
    vi.stubGlobal('__DOOP_APP_MENU__', true)
    initAppMenu()
    const [event, handler] = listen.mock.calls[0] as [string, (e: { payload: unknown }) => void]
    expect(event).toBe('app-menu')
    const host = stubHost()
    setActionHost(host)
    handler({ payload: { id: 'shortcuts', key: false } })
    handler({ payload: { id: 'no-such-command', key: false } })
    expect(host.openShortcuts).toHaveBeenCalledOnce()
  })
})
