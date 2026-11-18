// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { CanvasLibrary } from '../src/lib/api'

vi.mock('../src/lib/api', () => ({ api: {}, errorMessage: (_error: unknown, fallback: string) => fallback }))
vi.mock('../src/lib/store', () => ({ useStore: { getState: () => ({ pushNotice: () => {} }) } }))

import {
  cancelLibraryResume,
  clearLibraryResume,
  confirmLibraryResume,
  libraryResumeWaits,
  readLibraryResume,
  rememberLibraryResume,
  RESUME_TTL_MS,
  resumeStep,
  type LibraryResumeIntent,
} from '../src/lib/libraryResume'

/* The note that carries the library flow across Stripe Checkout: what is kept,
   for how long, where it sends the person back to, and what the Components
   panel does with it. The round trip through Stripe itself is not run here. */

const KEY = 'doop:library-resume'
const NOW = 1_800_000_000_000

const status = (over: Partial<CanvasLibrary> = {}): CanvasLibrary => ({
  billing: true,
  entitled: true,
  canPublish: true,
  workspaceId: 'ws1',
  library: false,
  changes: [],
  updates: [],
  ...over,
})
const intent = (over: Partial<LibraryResumeIntent> = {}): LibraryResumeIntent => ({
  canvasId: 'canvas1',
  workspaceId: 'ws1',
  at: NOW,
  ...over,
})
const view = (over: Partial<CanvasLibrary> = {}, canEdit = true) => ({
  canvasId: 'canvas1',
  canEdit,
  status: status(over),
})

beforeEach(() => localStorage.clear())

it('keeps the note for half an hour and no longer', () => {
  rememberLibraryResume({ canvasId: 'canvas1', workspaceId: 'ws1', componentId: 'c1' }, NOW)
  expect(readLibraryResume(NOW + 1000)).toEqual({ canvasId: 'canvas1', workspaceId: 'ws1', componentId: 'c1', at: NOW })
  expect(libraryResumeWaits('canvas1', NOW)).toBe(true)
  expect(libraryResumeWaits('canvas2', NOW)).toBe(false)
  expect(readLibraryResume(NOW + RESUME_TTL_MS + 1)).toBeNull()
  /* a clock set back does not make a note immortal */
  expect(readLibraryResume(NOW - 1)).toBeNull()
  clearLibraryResume()
  expect(readLibraryResume(NOW)).toBeNull()
})

it('reads nothing from a note it did not write', () => {
  for (const raw of [
    'not json',
    'null',
    JSON.stringify({ canvasId: 'canvas1', at: NOW }),
    JSON.stringify({ canvasId: '//evil.example', workspaceId: 'ws1', at: NOW }),
    JSON.stringify({ canvasId: '../../w/x', workspaceId: 'ws1', at: NOW }),
    JSON.stringify({ canvasId: 'canvas1', workspaceId: 'ws1', at: 'now' }),
  ]) {
    localStorage.setItem(KEY, raw)
    expect(readLibraryResume(NOW), raw).toBeNull()
    expect(confirmLibraryResume('ws1', NOW), raw).toBeNull()
  }
  /* a component id of another shape is left out, not trusted */
  localStorage.setItem(KEY, JSON.stringify({ canvasId: 'canvas1', workspaceId: 'ws1', componentId: 7, at: NOW }))
  expect(readLibraryResume(NOW)).toEqual({ canvasId: 'canvas1', workspaceId: 'ws1', at: NOW })
})

it('sends the person back to the canvas only from the workspace that was paid for', () => {
  rememberLibraryResume({ canvasId: 'canvas1', workspaceId: 'ws1' }, NOW)
  expect(confirmLibraryResume('ws2', NOW)).toBeNull()
  expect(readLibraryResume(NOW)?.paid).toBeUndefined()
  expect(confirmLibraryResume('ws1', NOW + 60_000)).toBe('/c/canvas1')
  /* confirming does not restart the clock */
  expect(readLibraryResume(NOW + 60_000)).toEqual({ canvasId: 'canvas1', workspaceId: 'ws1', at: NOW, paid: true })
  expect(confirmLibraryResume('ws1', NOW + RESUME_TTL_MS + 1)).toBeNull()
})

it('forgets the note when that checkout is cancelled', () => {
  rememberLibraryResume({ canvasId: 'canvas1', workspaceId: 'ws1' })
  cancelLibraryResume('ws2')
  expect(readLibraryResume()).not.toBeNull()
  cancelLibraryResume('ws1')
  expect(readLibraryResume()).toBeNull()
})

it('opens the publish dialog once the canvas is in the workspace and entitled', () => {
  expect(resumeStep(intent(), view())).toBe('publish')
  /* the webhook made the plan live though this browser never saw the return */
  expect(resumeStep(intent({ paid: true }), view())).toBe('publish')
})

it('moves a canvas that is in no workspace, but only after the plan was seen live', () => {
  const personal = view({ entitled: false, blocked: 'no_workspace', workspaceId: undefined })
  expect(resumeStep(intent({ paid: true }), personal)).toBe('move')
  expect(resumeStep(intent(), personal)).toBe('none')
})

it('waits while nothing is known or the plan is not live yet', () => {
  expect(resumeStep(intent(), { canvasId: 'canvas1', canEdit: true, status: null })).toBe('none')
  expect(resumeStep(intent({ paid: true }), view({ entitled: false, blocked: 'plan_required' }))).toBe('none')
  /* a note for another canvas is not this one's to take or to drop */
  expect(resumeStep(intent({ canvasId: 'canvas2', paid: true }), view())).toBe('none')
})

it('drops a note that no longer fits', () => {
  /* the canvas sits in another workspace now */
  expect(resumeStep(intent({ paid: true }), view({ workspaceId: 'ws2' }))).toBe('drop')
  expect(
    resumeStep(intent({ paid: true }), view({ entitled: false, blocked: 'plan_required', workspaceId: 'ws2' })),
  ).toBe('drop')
  /* its workspace is gone */
  expect(resumeStep(intent({ paid: true }), view({ entitled: false, blocked: 'no_workspace' }))).toBe('drop')
  /* the workspace keeps publishing to its admins, or this person only views */
  expect(resumeStep(intent(), view({ canPublish: false }))).toBe('drop')
  expect(resumeStep(intent(), view({}, false))).toBe('drop')
})
