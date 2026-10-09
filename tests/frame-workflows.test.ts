import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Actor, Frame } from '../shared/types.ts'

vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
  saveGuideline: () => {},
}))
const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const agent: Actor = { name: 'Agent', kind: 'agent', color: '#123456' }
const frame: Frame = {
  id: 'frame',
  canvasId: 'canvas',
  name: 'Hero',
  html: '<p>old</p>',
  x: 0,
  y: 0,
  width: 640,
  height: 480,
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'Me',
}
const flush = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  actions.wire(
    () => {},
    () => {},
  )
  vi.spyOn(store, 'getFrame').mockResolvedValue(frame)
  vi.spyOn(store, 'appendFrameHtml').mockResolvedValue(frame)
  vi.spyOn(store, 'updateFrame').mockResolvedValue(frame)
  vi.spyOn(store, 'createFrame').mockResolvedValue(frame)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('an older deadline cannot end a newer task for the same agent', async () => {
  await actions.createFrame(frame.canvasId, { name: frame.name, html: frame.html }, agent)
  await vi.advanceTimersByTimeAsync(4000)
  actions.setAgentStatus(frame.canvasId, agent, '')
  await actions.createFrame(frame.canvasId, { name: frame.name, html: frame.html }, agent)
  const newer = actions.getTasks(frame.canvasId)[0]!
  await vi.advanceTimersByTimeAsync(1000)
  expect(newer.endedAt).toBeUndefined()
  await vi.advanceTimersByTimeAsync(4000)
  expect(newer.endedAt).toBeDefined()
})

it('extends the deadline when the same task edits again', async () => {
  await actions.createFrame(frame.canvasId, { name: frame.name, html: frame.html }, agent)
  const task = actions.getTasks(frame.canvasId)[0]!
  await vi.advanceTimersByTimeAsync(4000)
  await actions.updateFrame(frame.id, { html: '<p>new</p>' }, agent)
  expect(actions.getTasks(frame.canvasId)[0]?.id).toBe(task.id)
  await vi.advanceTimersByTimeAsync(1000)
  expect(task.endedAt).toBeUndefined()
  await vi.advanceTimersByTimeAsync(4000)
  expect(task.endedAt).toBeDefined()
})

it('keeps a task open until every stream using it finishes', async () => {
  await actions.createFrame(frame.canvasId, { name: frame.name, html: frame.html }, agent)
  await actions.appendFrameHtml(frame.id, '<p>', agent, { start: true })
  await actions.appendFrameHtml('second', '<p>', agent, { start: true })
  const task = actions.getTasks(frame.canvasId)[0]!
  await vi.advanceTimersByTimeAsync(6000)
  expect(task.endedAt).toBeUndefined()
  await actions.appendFrameHtml(frame.id, '</p>', agent, { done: true })
  expect(task.endedAt).toBeUndefined()
  await actions.appendFrameHtml('second', '</p>', agent, { done: true })
  expect(task.endedAt).toBeDefined()
})

it('waits for an in-flight append before finishing and starting the next stream', async () => {
  await actions.appendFrameHtml(frame.id, '<p>', agent, { start: true })
  const previous = actions.getTasks(frame.canvasId)[0]!
  let release!: (value: Frame) => void
  vi.mocked(store.appendFrameHtml).mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve
    }),
  )
  const pending = actions.appendFrameHtml(frame.id, 'middle', agent)
  await flush()
  const done = actions.appendFrameHtml(frame.id, '</p>', agent, { done: true })
  const next = actions.appendFrameHtml(frame.id, '<p>next', agent, { start: true })
  await flush()
  expect(store.appendFrameHtml).toHaveBeenCalledTimes(2)
  expect(previous.endedAt).toBeUndefined()
  release(frame)
  await Promise.all([pending, done, next])
  expect(previous.endedAt).toBeDefined()
  const newer = actions.getTasks(frame.canvasId)[0]!
  expect(newer.id).not.toBe(previous.id)
  expect(newer.endedAt).toBeUndefined()
  await actions.appendFrameHtml(frame.id, '</p>', agent, { done: true })
})

it('continues a frame queue after a failed write', async () => {
  vi.mocked(store.appendFrameHtml).mockRejectedValueOnce(new Error('Unavailable'))
  const failed = actions.appendFrameHtml(frame.id, 'first', agent, { start: true })
  const recovered = actions.appendFrameHtml(frame.id, 'retry', agent, { start: true, done: true })
  await expect(failed).rejects.toThrow('Unavailable')
  expect(await recovered).toEqual(frame)
})

it('rechecks guideline names and limits after asynchronous placement reads', async () => {
  const canvas = { id: frame.canvasId, name: 'Canvas', createdAt: 1, updatedAt: 1, frames: [] }
  store.init([canvas])
  vi.spyOn(store, 'syncCanvas').mockResolvedValue(canvas)
  await Promise.all([
    store.setGuideline(canvas.id, 'brand', 'First', 'Me'),
    store.setGuideline(canvas.id, 'brand', 'Second', 'Me'),
  ])
  expect(store.getGuidelines(canvas.id)).toMatchObject([{ name: 'brand', markdown: 'Second' }])
  for (let n = 0; n < 18; n++) await store.setGuideline(canvas.id, `doc-${n}`, 'Rules', 'Me', { x: 0, y: n })
  const last = await Promise.allSettled([
    store.setGuideline(canvas.id, 'last-a', 'Rules', 'Me'),
    store.setGuideline(canvas.id, 'last-b', 'Rules', 'Me'),
  ])
  expect(last.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(last.filter((result) => result.status === 'rejected')).toHaveLength(1)
  expect(store.getGuidelines(canvas.id)).toHaveLength(actions.MAX_GUIDELINE_DOCS)
})
