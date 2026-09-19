import { describe, expect, it } from 'vitest'
import { locatePresence } from '../src/lib/locate'
import { useStore } from '../src/lib/store'
import type { Canvas, Presence } from '../shared/types'

/**
 * Clicking an avatar in the top bar flies to where that peer is. People are
 * at their cursor; agents at the frame they are editing, streaming into, or
 * last touched on a task.
 */

const frame = { id: 'f1', canvasId: 'c', name: 'Hero', x: 0, y: 0, width: 10, height: 10, html: '' }
const canvas = { id: 'c', name: 'c', frames: [frame] } as unknown as Canvas
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
