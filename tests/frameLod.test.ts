import { describe, expect, it } from 'vitest'
import { MIN_LIVE_PX, frameImageUrl, frameLods, type LodOptions, type LodRect } from '../src/lib/frameLod.ts'

const screen = { width: 1000, height: 800 }
const atRest = { x: 0, y: 0, zoom: 1 }
const none = new Set<string>()
const options = (patch: Partial<LodOptions> = {}): LodOptions => ({
  budget: 3,
  pinned: none,
  preferred: none,
  ...patch,
})
const frame = (id: string, x: number, y: number, width = 400, height = 300): LodRect => ({ id, x, y, width, height })

describe('frameLods', () => {
  it('draws on-screen frames live within the budget', () => {
    const lods = frameLods([frame('a', 0, 0), frame('b', 500, 0)], atRest, screen, options())
    expect(lods.get('a')).toBe('live')
    expect(lods.get('b')).toBe('live')
  })

  it('leaves frames far off screen out', () => {
    const lods = frameLods([frame('far', 5000, 5000)], atRest, screen, options())
    expect(lods.has('far')).toBe(false)
  })

  it('counts a frame just past the edge as on screen', () => {
    const lods = frameLods([frame('near', 1100, 0)], atRest, screen, options())
    expect(lods.get('near')).toBe('live')
  })

  it('gives the budget to the frames that fill the most screen', () => {
    const frames = [frame('small', 0, 0, 200, 200), frame('big', 300, 0, 600, 600), frame('mid', 0, 300, 300, 300)]
    const lods = frameLods(frames, atRest, screen, options({ budget: 2 }))
    expect(lods.get('big')).toBe('live')
    expect(lods.get('mid')).toBe('live')
    expect(lods.get('small')).toBe('image')
  })

  it('counts only the part of a frame that is on screen', () => {
    /* a 6000px page mostly below the fold fills less screen than a card */
    const frames = [frame('page', 0, 700, 1280, 6000), frame('card', 0, 0, 700, 600)]
    const lods = frameLods(frames, atRest, screen, options({ budget: 1 }))
    expect(lods.get('card')).toBe('live')
    expect(lods.get('page')).toBe('image')
  })

  it('draws frames too small to work in as images', () => {
    const tiny = MIN_LIVE_PX - 1
    const lods = frameLods([frame('a', 0, 0, tiny * 10, tiny)], atRest, screen, options())
    expect(lods.get('a')).toBe('image')
  })

  it('draws everything as images when zoomed far out', () => {
    const frames = [frame('a', 0, 0, 1280, 3000), frame('b', 1400, 0, 1280, 3000)]
    const lods = frameLods(frames, { x: 0, y: 0, zoom: 0.05 }, screen, options())
    expect([...lods.values()]).toEqual(['image', 'image'])
  })

  it('applies the camera offset and zoom', () => {
    const camera = { x: -800, y: 0, zoom: 0.5 }
    expect(frameLods([frame('a', 2000, 0)], camera, screen, options()).get('a')).toBe('live')
    expect(frameLods([frame('b', 6000, 0)], camera, screen, options()).has('b')).toBe(false)
  })

  it('keeps pinned frames live off screen and outside the budget', () => {
    const frames = [frame('a', 0, 0), frame('b', 500, 0), frame('sel', 9000, 9000)]
    const lods = frameLods(frames, atRest, screen, options({ budget: 1, pinned: new Set(['sel']) }))
    expect(lods.get('sel')).toBe('live')
    expect([...lods.values()].filter((l) => l === 'live')).toHaveLength(2)
  })

  it('puts preferred frames ahead of larger ones while on screen', () => {
    const frames = [frame('big', 0, 0, 900, 700), frame('stream', 0, 0, 200, 200), frame('gone', 9000, 0)]
    const preferred = new Set(['stream', 'gone'])
    const lods = frameLods(frames, atRest, screen, options({ budget: 1, preferred }))
    expect(lods.get('stream')).toBe('live')
    expect(lods.get('big')).toBe('image')
    expect(lods.has('gone')).toBe(false)
  })

  it('draws nothing live with a zero budget', () => {
    const lods = frameLods([frame('a', 0, 0)], atRest, screen, options({ budget: 0 }))
    expect(lods.get('a')).toBe('image')
  })
})

describe('frameImageUrl', () => {
  it('versions the url by the frame update time', () => {
    expect(frameImageUrl({ id: 'f1', updatedAt: 42 }, false)).toBe('/i/f1.jpg?quality=80&v=42')
  })

  it('keeps standalone elements transparent', () => {
    expect(frameImageUrl({ id: 'f1', updatedAt: 42 }, true)).toBe('/i/f1.png?v=42')
  })
})
