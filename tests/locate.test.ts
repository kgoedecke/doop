import { describe, expect, it } from 'vitest'
import { locatePresence } from '../src/lib/locate'
import { taskFrameId } from '../src/lib/taskFrame'
import { useStore } from '../src/lib/store'
import type { Canvas, Presence } from '../shared/types'

/**
 * Clicking an avatar in the top bar flies to where that peer is. People are
 * at their cursor; agents at the frame they are editing, streaming into, or
 * last touched on a task.
 */

const frame = { id: 'f1', canvasId: 'c', name: 'Hero', x: 0, y: 0, width: 10, height: 10, html: '' }
const other = { ...frame, id: 'f2', name: 'Pricing' }
const canvas = { id: 'c', name: 'c', frames: [frame, other] } as unknown as Canvas
const person: Presence = { clientId: 'u1', name: 'Ada', color: '#000', kind: 'user' }
const agent: Presence = { clientId: 'a1', name: 'Claude', color: '#000', kind: 'agent' }

function seed(patch: Partial<ReturnType<typeof useStore.getState>>) {
  useStore.setState({ canvas, cursors: {}, streams: {}, tasks: [], ...patch })
  return useStore.getState()
}

describe('locatePresence', () => {
  it('puts a person at their live cursor, then at the frame they picked', () => {
    expect(locatePresence(person, seed({ cursors: { u1: { x: 3, y: 4 } } }))).toEqual({ point: { x: 3, y: 4 } })
    expect(locatePresence({ ...person, activeFrameId: 'f1' }, seed({}))).toEqual({ frameId: 'f1' })
    expect(locatePresence(person, seed({}))).toBeUndefined()
  })

  it('puts an agent at the frame it edits, streams into, or last touched', () => {
    expect(locatePresence({ ...agent, activeFrameId: 'f1' }, seed({}))).toEqual({ frameId: 'f1' })
    expect(locatePresence(agent, seed({ streams: { f1: { name: 'Claude', color: '#000' } } }))).toEqual({
      frameId: 'f1',
    })
    const task = { id: 't', agentName: 'Claude', color: '#000', status: 'x', startedAt: 0, frameIds: ['gone', 'f1'] }
    expect(locatePresence(agent, seed({ tasks: [task] }))).toEqual({ frameId: 'f1' })
    expect(locatePresence(agent, seed({}))).toBeUndefined()
  })
})

/* Two outside agents may both be "Claude" (shared/agentIdentity.ts): each
   face and each task goes to its own agent's frame, never the other's. */
describe('agents sharing a name', () => {
  const ana: Presence = { ...agent, clientId: 'agent:mcp:ana', agentKey: 'mcp:ana', owner: 'Ana' }
  const ben: Presence = { ...agent, clientId: 'agent:mcp:ben', agentKey: 'mcp:ben', owner: 'Ben' }
  const streams = {
    f1: { name: 'Claude', color: '#000', agentKey: 'mcp:ana' },
    f2: { name: 'Claude', color: '#000', agentKey: 'mcp:ben' },
  }

  it('finds the frame each one streams into', () => {
    const s = seed({ streams })
    expect(locatePresence(ana, s)).toEqual({ frameId: 'f1' })
    expect(locatePresence(ben, s)).toEqual({ frameId: 'f2' })
  })

  it('sends a running task to its own agent’s focus or stream', () => {
    const task = (agentKey: string) => ({
      id: agentKey,
      agentName: 'Claude',
      agentKey,
      color: '#000',
      status: 'x',
      startedAt: 0,
    })
    const focused = seed({
      presences: { [ana.clientId]: { ...ana, activeFrameId: 'f1' }, [ben.clientId]: { ...ben, activeFrameId: 'f2' } },
    })
    expect(taskFrameId(task('mcp:ben'), focused)).toBe('f2')
    expect(taskFrameId(task('mcp:ana'), focused)).toBe('f1')
    const streaming = seed({ presences: { [ana.clientId]: ana, [ben.clientId]: ben }, streams })
    expect(taskFrameId(task('mcp:ben'), streaming)).toBe('f2')
  })
})
