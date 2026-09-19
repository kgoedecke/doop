import { describe, expect, it } from 'vitest'
import { cameraOnCursor, cameraToFollow } from '../src/lib/follow'
import { useStore } from '../src/lib/store'
import type { Presence } from '../shared/types'

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
    const leader = { x: 0, y: 0, zoom: 3, width: 10, height: 10 }
    expect(cameraToFollow(leader, { width: 4000, height: 4000 }).zoom).toBe(3)
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

  it('records a peer camera on their presence', () => {
    const s = useStore.getState()
    s.setPresences([peer])
    s.setPeerViewport('p1', { x: 5, y: 6, zoom: 1.5, width: 900, height: 700 })
    expect(useStore.getState().presences.p1?.viewport).toEqual({ x: 5, y: 6, zoom: 1.5, width: 900, height: 700 })
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
