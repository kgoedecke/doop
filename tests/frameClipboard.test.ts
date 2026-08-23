import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createFrame: vi.fn(),
  uploadAsset: vi.fn(),
  select: vi.fn(),
  capture: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: { createFrame: mocks.createFrame, uploadAsset: mocks.uploadAsset },
}))
vi.mock('../src/lib/store', () => ({
  useStore: { getState: () => ({ viewport: { x: 0, y: 0, zoom: 1 }, select: mocks.select }) },
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: mocks.capture } }))
vi.mock('../src/lib/history', () => ({ recordCreate: vi.fn() }))

import { hasFrameClip, pasteFrameCentered } from '../src/lib/frameClipboard'

const CLIP_KEY = 'doop:frame-clipboard'

describe('frame clipboard persistence', () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    })
    vi.clearAllMocks()
  })

  it('discards malformed JSON instead of throwing during paste', () => {
    localStorage.setItem(CLIP_KEY, '{not json')

    expect(() => pasteFrameCentered('canvas-1')).not.toThrow()
    expect(localStorage.getItem(CLIP_KEY)).toBeNull()
    expect(mocks.createFrame).not.toHaveBeenCalled()
  })

  it('does not advertise structurally invalid clipboard data', () => {
    localStorage.setItem(CLIP_KEY, JSON.stringify({ name: 'Missing dimensions' }))

    expect(hasFrameClip()).toBe(false)
    expect(localStorage.getItem(CLIP_KEY)).toBeNull()
  })

  it('recognizes a complete frame clip', () => {
    localStorage.setItem(CLIP_KEY, JSON.stringify({ name: 'Hero', html: '<h1>Hero</h1>', width: 640, height: 480 }))

    expect(hasFrameClip()).toBe(true)
  })
})
