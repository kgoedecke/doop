import { describe, expect, it } from 'vitest'
import { agentFollowFrame, agentFollowKey, cameraOnCursor, cameraToFollow } from '../src/lib/follow'
import { useStore } from '../src/lib/store'
import type { Canvas, Frame, Presence } from '../shared/types'

/**
 * Following a peer (Figma-style) means showing what they see. Screens differ,
 * so their visible world rect is fitted into ours; and any camera move of our
 * own — pan, zoom, fit, fly-to — lets go.
 */

describe('cameraToFollow', () => {
  it('reproduces the leader camera exactly on an identical stage', () => {
    const leader = { x: -120, y: 40, zoom: 0.5, width: 1200, height: 800 }
    expect(cameraToFollow(leader, { width: 1200, height: 800 })).toEqual({ x: -120, y: 40, zoom: 0.5 })
  })

  it('keeps everything the leader sees on a smaller stage by zooming out and centring', () => {
    const leader = { x: 0, y: 0, zoom: 1, width: 1000, height: 1000 }
    const cam = cameraToFollow(leader, { width: 500, height: 250 })
    expect(cam.zoom).toBeCloseTo(0.25)
    /* the leader's world centre (500,500) lands on our screen centre (250,125) */
    expect(cam.x).toBeCloseTo(250 - 500 * 0.25)
    expect(cam.y).toBeCloseTo(125 - 500 * 0.25)
  })

  it('never zooms past the stage limits', () => {
    const leader = { x: 0, y: 0, zoom: 16, width: 10, height: 10 }
    expect(cameraToFollow(leader, { width: 4000, height: 4000 }).zoom).toBe(16)
  })
})

describe('cameraOnCursor', () => {
  it('centres the cursor at our current zoom', () => {
    expect(cameraOnCursor({ x: 100, y: 200 }, { width: 800, height: 600 }, 2)).toEqual({ x: 200, y: -100, zoom: 2 })
  })
})

const peer: Presence = { clientId: 'p1', name: 'Ada', color: '#123', kind: 'user' }

describe('follow state', () => {
  it('ends when the camera is moved by hand, not by the follow loop', () => {
    const s = useStore.getState()
    s.setPresences([peer])
    s.setFollowing('p1')
    s.setViewportFollowing({ x: 1, y: 2, zoom: 1 })
    expect(useStore.getState().following).toBe('p1')
    s.setViewport({ x: 3, y: 4, zoom: 1 })
    expect(useStore.getState().following).toBeNull()
  })

  it('ends when the leader leaves or a fresh roster lacks them', () => {
    const s = useStore.getState()
    s.setPresences([peer])
    s.setFollowing('p1')
    s.removePresence('p1')
    expect(useStore.getState().following).toBeNull()

    s.setPresences([peer])
    s.setFollowing('p1')
    s.setPresences([])
    expect(useStore.getState().following).toBeNull()
  })

  it('records a peer camera beside the roster, leaving presences untouched', () => {
    const s = useStore.getState()
    s.setPresences([peer])
    const before = useStore.getState().presences
    s.setPeerViewport('p1', { x: 5, y: 6, zoom: 1.5, width: 900, height: 700 })
    expect(useStore.getState().peerViewports.p1).toEqual({ x: 5, y: 6, zoom: 1.5, width: 900, height: 700 })
    expect(useStore.getState().presences).toBe(before)
    s.removePresence('p1')
    expect(useStore.getState().peerViewports.p1).toBeUndefined()
  })

  it('seeds a peer camera from the roster and drops it on a fresh roster', () => {
    const s = useStore.getState()
    s.setPresences([{ ...peer, viewport: { x: 1, y: 2, zoom: 1, width: 800, height: 600 } }])
    expect(useStore.getState().peerViewports.p1?.x).toBe(1)
    s.setPresences([])
    expect(useStore.getState().peerViewports.p1).toBeUndefined()
  })
})

/**
 * Following an agent means watching it work: the camera goes to the frame it
 * works on, and the follow survives the agent going idle, when it drops out of
 * the roster, so the camera moves again the moment it is back at work.
 */
const frame = (id: string, x = 0): Frame => ({
  ...{ id, canvasId: 'c', name: id, x, y: 0, width: 100, height: 80, html: '' },
  ...{ createdAt: 0, updatedAt: 0, updatedBy: 'Doop' },
})
const agent: Presence = { clientId: 'agent:Doop', name: 'Doop', color: '#456', kind: 'agent' }

describe('following an agent', () => {
  function seed() {
    useStore.setState({
      canvas: { id: 'c', name: 'c', frames: [frame('f1'), frame('f2', 400)] } as unknown as Canvas,
      cursors: {},
      streams: {},
      tasks: [],
      following: null,
      followedAgent: null,
    })
    const s = useStore.getState()
    s.setPresences([{ ...agent, activeFrameId: 'f1' }])
    s.setFollowing(agent.clientId)
    return s
  }

  it('targets the frame the agent works on, and the next one it moves to', () => {
    const s = seed()
    expect(agentFollowFrame(useStore.getState())?.id).toBe('f1')
    s.setEditing(agent.clientId, 'f2')
    expect(agentFollowFrame(useStore.getState())?.id).toBe('f2')
  })

  it('stays on while the agent is idle and out of the roster, and picks up when it returns', () => {
    const s = seed()
    s.removePresence(agent.clientId)
    expect(useStore.getState().following).toBe(agent.clientId)
    expect(useStore.getState().followedAgent?.name).toBe('Doop')
    /* idle: the camera stays on the frame it was last seen on */
    expect(agentFollowFrame(useStore.getState())?.id).toBe('f1')
    /* a reconnect's roster without it keeps the follow too */
    s.setPresences([])
    expect(useStore.getState().following).toBe(agent.clientId)
    /* back at work on another frame */
    s.upsertPresence({ ...agent, activeFrameId: 'f2' })
    expect(agentFollowFrame(useStore.getState())?.id).toBe('f2')
  })

  it('ends on a camera move of our own, the pill, or another canvas', () => {
    let s = seed()
    s.setViewport({ x: 1, y: 1, zoom: 1 })
    expect(useStore.getState().following).toBeNull()

    s = seed()
    s.setFollowing(null)
    expect(useStore.getState().followedAgent).toBeNull()

    s = seed()
    s.setCanvas({ id: 'other', name: 'o', frames: [] } as unknown as Canvas)
    expect(useStore.getState().following).toBeNull()
  })

  it('moves again when the frame moves or widens, not as a stream makes it taller', () => {
    expect(agentFollowKey(frame('f1'))).toBe(agentFollowKey(frame('f1')))
    expect(agentFollowKey({ ...frame('f1'), height: 900 })).toBe(agentFollowKey(frame('f1')))
    expect(agentFollowKey({ ...frame('f1'), width: 900 })).not.toBe(agentFollowKey(frame('f1')))
    expect(agentFollowKey(frame('f1', 50))).not.toBe(agentFollowKey(frame('f1')))
    expect(agentFollowKey(undefined)).toBe('')
  })

  it('goes idle from the frame it was on last, not the one it was on when the follow began', () => {
    const s = seed()
    s.setEditing(agent.clientId, 'f2')
    s.removePresence(agent.clientId)
    expect(agentFollowFrame(useStore.getState())?.id).toBe('f2')
    s.upsertPresence({ ...agent, activeFrameId: 'f1' })
    s.setPresences([])
    expect(agentFollowFrame(useStore.getState())?.id).toBe('f1')
  })

  it('forgets the agent whenever the follow ends, and keeps it across its own page moves', () => {
    const s = seed()
    s.setViewport({ x: 1, y: 1, zoom: 1 })
    expect(useStore.getState().followedAgent).toBeNull()
    s.setFollowing(agent.clientId)
    s.removePresence(agent.clientId)
    /* the agent is out of the roster: it can be followed only while the follow lasts */
    s.setFollowing(null)
    s.setFollowing(agent.clientId)
    expect(useStore.getState().following).toBeNull()
  })

  it('has no target for a person, or an agent that has touched nothing yet', () => {
    const s = seed()
    s.setPresences([peer])
    s.setFollowing('p1')
    expect(agentFollowFrame(useStore.getState())).toBeUndefined()
    s.setPresences([agent])
    s.setFollowing(agent.clientId)
    expect(agentFollowFrame(useStore.getState())).toBeUndefined()
  })
})

describe('isPeerViewport', () => {
  it('accepts a finite camera with a positive zoom and stage', async () => {
    const { isPeerViewport } = await import('../shared/viewport')
    expect(isPeerViewport({ x: -10, y: 0, zoom: 0.5, width: 1200, height: 800 })).toBe(true)
  })

  it('rejects zero or non-finite zoom, empty stages, and junk', async () => {
    const { isPeerViewport } = await import('../shared/viewport')
    expect(isPeerViewport({ x: 0, y: 0, zoom: 0, width: 10, height: 10 })).toBe(false)
    expect(isPeerViewport({ x: 0, y: 0, zoom: Infinity, width: 10, height: 10 })).toBe(false)
    expect(isPeerViewport({ x: NaN, y: 0, zoom: 1, width: 10, height: 10 })).toBe(false)
    expect(isPeerViewport({ x: 0, y: 0, zoom: 1, width: 0, height: 10 })).toBe(false)
    expect(isPeerViewport({ x: '0', y: 0, zoom: 1, width: 10, height: 10 })).toBe(false)
    expect(isPeerViewport(null)).toBe(false)
    expect(isPeerViewport('camera')).toBe(false)
  })
})
