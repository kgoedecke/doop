// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation, AutomationRun } from '../shared/automations'
import { isRunShortcut, RUN_SHORTCUT_HINT } from '../src/lib/keys'
import { TooltipProvider } from '../src/components/ui/tooltip'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  getAutomation: vi.fn(),
  listCanvases: vi.fn(),
  integrations: vi.fn(),
  updateAutomation: vi.fn(),
  runAutomation: vi.fn(),
  listRuns: vi.fn(),
  capture: vi.fn(),
}))

vi.mock('../src/App', () => ({ navigate: vi.fn() }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: mocks.capture } }))
vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getAutomation: mocks.getAutomation,
      listCanvases: mocks.listCanvases,
      integrations: mocks.integrations,
      updateAutomation: mocks.updateAutomation,
      runAutomation: mocks.runAutomation,
      listRuns: mocks.listRuns,
    },
  }
})

const { AutomationEditor } = await import('../src/pages/AutomationEditor')

function sampleAutomation(over: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    name: 'Daily Review',
    enabled: true,
    trigger: { type: 'schedule' },
    schedule: { kind: 'daily', weekday: 1, hour: 9, minute: 0, tz: 'UTC' },
    steps: [
      {
        id: 's1',
        type: 'agent',
        title: 'Review Step',
        prompt: 'Review the latest designs',
        roles: ['doop'],
        canvasId: 'c1',
      },
    ],
    nextRunAt: Date.now() + 3600000,
    lastRun: null,
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now() - 86400000,
    ...over,
  }
}

function sampleRun(over: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'auto-1',
    startedAt: Date.now(),
    endedAt: Date.now() + 1000,
    status: 'ok',
    summary: '1 card queued',
    error: null,
    canvasId: 'c1',
    failure: null,
    ...over,
  }
}

describe('isRunShortcut unit tests', () => {
  const chord = (over: Partial<Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>>) => ({
    key: 'r',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  })

  it('matches ⌘R on macOS and Ctrl+R on Windows/Linux', () => {
    // macOS: metaKey (Command)
    expect(isRunShortcut(chord({ metaKey: true }))).toBe(true)
    // Windows/Linux: ctrlKey (Control)
    expect(isRunShortcut(chord({ ctrlKey: true }))).toBe(true)
    // Case-insensitive ('R' with CapsLock)
    expect(isRunShortcut(chord({ key: 'R', metaKey: true }))).toBe(true)
    expect(isRunShortcut(chord({ key: 'R', ctrlKey: true }))).toBe(true)
  })

  it('rejects keys without Command or Control modifiers', () => {
    // Plain 'r' while typing or viewing
    expect(isRunShortcut(chord({}))).toBe(false)
  })

  it('rejects chords with Shift to protect browser hard-reload', () => {
    // ⌘⇧R / Ctrl+Shift+R is hard refresh in browsers
    expect(isRunShortcut(chord({ metaKey: true, shiftKey: true }))).toBe(false)
    expect(isRunShortcut(chord({ ctrlKey: true, shiftKey: true }))).toBe(false)
  })

  it('rejects chords with Alt/Option to avoid OS/app collisions', () => {
    expect(isRunShortcut(chord({ metaKey: true, altKey: true }))).toBe(false)
    expect(isRunShortcut(chord({ ctrlKey: true, altKey: true }))).toBe(false)
  })

  it('rejects other keys even with modifiers', () => {
    expect(isRunShortcut(chord({ key: 's', metaKey: true }))).toBe(false)
    expect(isRunShortcut(chord({ key: 'Enter', metaKey: true }))).toBe(false)
    expect(isRunShortcut(chord({ key: 'z', metaKey: true }))).toBe(false)
    expect(isRunShortcut(chord({ key: 'a', metaKey: true }))).toBe(false)
  })

  it('exposes platform-appropriate RUN_SHORTCUT_HINT', () => {
    expect(RUN_SHORTCUT_HINT).toMatch(/^(⌘|Ctrl\+)R$/)
  })
})

describe('AutomationEditor Run shortcut integration tests', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listCanvases.mockResolvedValue([{ id: 'c1', name: 'Main Canvas' }])
    mocks.integrations.mockResolvedValue({})
    mocks.listRuns.mockResolvedValue([])
    mocks.runAutomation.mockResolvedValue(sampleRun())
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  async function renderEditor(auto: Automation = sampleAutomation()) {
    mocks.getAutomation.mockResolvedValue(auto)
    await act(async () => {
      root.render(
        <TooltipProvider>
          <AutomationEditor automationId={auto.id} />
        </TooltipProvider>,
      )
    })
    // flush pending microtasks for api.getAutomation
    await act(async () => {
      await Promise.resolve()
    })
  }

  function dispatchKeydown(over: Partial<KeyboardEventInit> = {}, target: EventTarget = window): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key: 'r',
      bubbles: true,
      cancelable: true,
      metaKey: true,
      ...over,
    })
    target.dispatchEvent(event)
    return event
  }

  it('1. Shortcut triggers the Run action', async () => {
    await renderEditor()
    expect(mocks.runAutomation).not.toHaveBeenCalled()

    await act(async () => {
      dispatchKeydown({ metaKey: true })
    })

    expect(mocks.runAutomation).toHaveBeenCalledTimes(1)
    expect(mocks.runAutomation).toHaveBeenCalledWith('auto-1')
    expect(mocks.capture).toHaveBeenCalledWith('automation_run_now', { status: 'ok' })
  })

  it('2. Run button and keyboard shortcut invoke the same handler', async () => {
    await renderEditor()

    // 1st run via keyboard shortcut
    await act(async () => {
      dispatchKeydown({ metaKey: true })
    })
    expect(mocks.runAutomation).toHaveBeenCalledTimes(1)

    // 2nd run via Run button click
    const runBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('Run now'),
    )
    expect(runBtn).not.toBeNull()

    await act(async () => {
      runBtn!.click()
    })
    expect(mocks.runAutomation).toHaveBeenCalledTimes(2)
  })

  it('3. macOS modifier behavior: metaKey triggers Run action', async () => {
    await renderEditor()

    await act(async () => {
      dispatchKeydown({ metaKey: true, ctrlKey: false })
    })

    expect(mocks.runAutomation).toHaveBeenCalledTimes(1)
  })

  it('4. Windows/Linux modifier behavior: ctrlKey triggers Run action', async () => {
    await renderEditor()

    await act(async () => {
      dispatchKeydown({ metaKey: false, ctrlKey: true })
    })

    expect(mocks.runAutomation).toHaveBeenCalledTimes(1)
  })

  it('5. Shortcut does not trigger browser refresh (preventDefault called)', async () => {
    await renderEditor()

    let event: KeyboardEvent
    await act(async () => {
      event = dispatchKeydown({ metaKey: true })
    })

    expect(event!.defaultPrevented).toBe(true)
  })

  it('6. Shortcut does not execute in unrelated input fields', async () => {
    await renderEditor()

    // Create an unrelated input field and focus it
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()

    await act(async () => {
      dispatchKeydown({ metaKey: true }, input)
    })

    expect(mocks.runAutomation).not.toHaveBeenCalled()

    // Create a textarea and focus it
    const textarea = document.createElement('textarea')
    document.body.append(textarea)
    textarea.focus()

    await act(async () => {
      dispatchKeydown({ metaKey: true }, textarea)
    })

    expect(mocks.runAutomation).not.toHaveBeenCalled()

    input.remove()
    textarea.remove()
  })

  it('7. Shortcut does not execute when Run is disabled', async () => {
    // Disabled automation: enabled = false
    const disabledAuto = sampleAutomation({ enabled: false })
    await renderEditor(disabledAuto)

    await act(async () => {
      dispatchKeydown({ metaKey: true })
    })

    expect(mocks.runAutomation).not.toHaveBeenCalled()
  })

  it('8. Shortcut does not cause duplicate execution (e.repeat is ignored)', async () => {
    await renderEditor()

    // Key repeat event when user holds down the shortcut keys
    await act(async () => {
      dispatchKeydown({ metaKey: true, repeat: true })
    })

    expect(mocks.runAutomation).not.toHaveBeenCalled()
  })

  it('9. Busy/running states are handled correctly', async () => {
    let finishRun!: (value: AutomationRun) => void
    const pendingPromise = new Promise<AutomationRun>((resolve) => {
      finishRun = resolve
    })
    mocks.runAutomation.mockReturnValueOnce(pendingPromise)

    await renderEditor()

    // Trigger run
    await act(async () => {
      dispatchKeydown({ metaKey: true })
    })
    expect(mocks.runAutomation).toHaveBeenCalledTimes(1)

    // Second press while first is still pending (busy/running)
    await act(async () => {
      dispatchKeydown({ metaKey: true })
    })
    expect(mocks.runAutomation).toHaveBeenCalledTimes(1)

    // Complete the first run
    await act(async () => {
      finishRun(sampleRun())
    })

    // Now that running has finished, pressing shortcut again triggers a new run
    mocks.runAutomation.mockResolvedValueOnce(sampleRun())
    await act(async () => {
      dispatchKeydown({ metaKey: true })
    })
    expect(mocks.runAutomation).toHaveBeenCalledTimes(2)
  })

  it('10. Existing Run functionality remains unchanged', async () => {
    await renderEditor()

    const runBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('Run now'),
    )
    expect(runBtn).not.toBeNull()
    expect(runBtn!.disabled).toBe(false)
    expect(runBtn!.getAttribute('title')).toContain(RUN_SHORTCUT_HINT)

    await act(async () => {
      runBtn!.click()
    })
    expect(mocks.runAutomation).toHaveBeenCalledTimes(1)
  })
})
