import { beforeEach, expect, it } from 'vitest'
import { canvasPages, pageFrames } from '../shared/pages'
import type { Canvas } from '../shared/types'
import { useStore } from '../src/lib/store'

const legacy = {
  id: 'legacy',
  name: 'Legacy',
  frames: [
    {
      id: 'old',
      canvasId: 'legacy',
      name: 'Old',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      html: '',
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 'User',
    },
  ],
  createdAt: 0,
  updatedAt: 0,
} satisfies Canvas
beforeEach(() => useStore.getState().setCanvas(null))

it('keeps legacy frames on their original page when pages are reordered', () => {
  const first = canvasPages(legacy)[0]!
  useStore.getState().setCanvas(legacy)
  useStore.getState().setPages([{ id: 'new', name: 'New' }, first])
  const canvas = useStore.getState().canvas!
  expect(pageFrames(canvas, first.id).map((f) => f.id)).toEqual(['old'])
  expect(pageFrames(canvas, 'new')).toEqual([])
})

it('clears selection on page switches and follows frame navigation across pages', () => {
  useStore.getState().setCanvas({ ...legacy, pages: [...canvasPages(legacy), { id: 'new', name: 'New' }] })
  useStore.getState().select('old')
  useStore.getState().setActivePage('new')
  expect(useStore.getState().selectedIds).toEqual([])
  useStore.getState().requestFlyTo('old')
  expect(useStore.getState().activePageId).toBe(canvasPages(legacy)[0]!.id)
  useStore.getState().setActivePage('missing')
  expect(useStore.getState().activePageId).toBe(canvasPages(legacy)[0]!.id)
})
