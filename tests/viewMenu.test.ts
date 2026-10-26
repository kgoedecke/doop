import { afterEach, expect, it, vi } from 'vitest'
import { NO_CANVAS, isViewCommand, onViewCommand, runViewCommand, syncViewMenu } from '../src/lib/viewMenu'

afterEach(() => vi.unstubAllGlobals())

const STATE = { ...NO_CANVAS, canvas: true, rulers: true, ui: true, uiToggle: true }

it('accepts only the commands the shell menu sends', () => {
  expect(isViewCommand('rulers')).toBe(true)
  expect(isViewCommand('zoom-selection')).toBe(true)
  expect(isViewCommand('close-tab')).toBe(false)
  expect(isViewCommand(undefined)).toBe(false)
})

it('hands each command to every subscriber until it unsubscribes', () => {
  const first = vi.fn()
  const second = vi.fn()
  const offFirst = onViewCommand(first)
  const offSecond = onViewCommand(second)
  runViewCommand('zoom-in')
  offFirst()
  runViewCommand('layers')
  offSecond()
  runViewCommand('agents')
  expect(first.mock.calls).toEqual([['zoom-in']])
  expect(second.mock.calls).toEqual([['zoom-in'], ['layers']])
})

it('mirrors the state into a shell that has the View menu', () => {
  const invoke = vi.fn(() => Promise.resolve())
  vi.stubGlobal('__TAURI__', { core: { invoke } })
  vi.stubGlobal('__DOOP_VIEW_MENU__', true)
  syncViewMenu(STATE)
  expect(invoke).toHaveBeenCalledWith('view_menu_state', STATE)
})

it('sends nothing to a shell older than the View menu, or outside one', () => {
  const invoke = vi.fn(() => Promise.resolve())
  vi.stubGlobal('__TAURI__', { core: { invoke } })
  syncViewMenu(STATE)
  vi.unstubAllGlobals()
  syncViewMenu(STATE)
  expect(invoke).not.toHaveBeenCalled()
})
