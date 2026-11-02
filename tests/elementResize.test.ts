import { describe, expect, it } from 'vitest'
import {
  MIN_ELEMENT_SIZE,
  RESIZE_CORNERS,
  RESIZE_EDGES,
  handleAnchor,
  handleCursor,
  resizePatch,
  resizedSize,
  sizeLabel,
} from '../src/lib/elementResize'

const base = { width: 200, height: 100 }

describe('resizedSize', () => {
  it('moves only the axes the handle owns', () => {
    expect(resizedSize('e', base, { dx: 30, dy: 50 })).toEqual({ width: 230, height: 100 })
    expect(resizedSize('s', base, { dx: 30, dy: 50 })).toEqual({ width: 200, height: 150 })
    expect(resizedSize('se', base, { dx: 30, dy: 50 })).toEqual({ width: 230, height: 150 })
  })
  it('grows when a west or north side is pulled outward', () => {
    expect(resizedSize('w', base, { dx: -30, dy: 50 })).toEqual({ width: 230, height: 100 })
    expect(resizedSize('n', base, { dx: 30, dy: -50 })).toEqual({ width: 200, height: 150 })
    expect(resizedSize('nw', base, { dx: -30, dy: -50 })).toEqual({ width: 230, height: 150 })
    expect(resizedSize('ne', base, { dx: 30, dy: 50 })).toEqual({ width: 230, height: 50 })
    expect(resizedSize('sw', base, { dx: 30, dy: 50 })).toEqual({ width: 170, height: 150 })
  })
  it('rounds to whole pixels and never collapses the box', () => {
    expect(resizedSize('se', base, { dx: 0.4, dy: -0.6 })).toEqual({ width: 200, height: 99 })
    expect(resizedSize('se', base, { dx: -500, dy: -500 })).toEqual({
      width: MIN_ELEMENT_SIZE,
      height: MIN_ELEMENT_SIZE,
    })
  })
  it('keeps the aspect ratio when asked, the larger corner move leading', () => {
    expect(resizedSize('se', base, { dx: 100, dy: 10 }, { keepRatio: true })).toEqual({ width: 300, height: 150 })
    expect(resizedSize('se', base, { dx: 10, dy: 50 }, { keepRatio: true })).toEqual({ width: 300, height: 150 })
    expect(resizedSize('e', base, { dx: -100, dy: 0 }, { keepRatio: true })).toEqual({ width: 100, height: 50 })
    expect(resizedSize('s', base, { dx: 0, dy: 20 }, { keepRatio: true })).toEqual({ width: 240, height: 120 })
    expect(resizedSize('nw', base, { dx: -100, dy: -10 }, { keepRatio: true })).toEqual({ width: 300, height: 150 })
  })
  it('ignores the ratio of a box with no size yet', () => {
    expect(resizedSize('se', { width: 0, height: 0 }, { dx: 40, dy: 10 }, { keepRatio: true })).toEqual({
      width: 40,
      height: 10,
    })
  })
})

describe('resizePatch', () => {
  it('writes only the dragged axes, so an auto height survives a width drag', () => {
    expect(resizePatch('e', { width: 230, height: 100 })).toEqual({ width: '230px' })
    expect(resizePatch('s', { width: 230, height: 100 })).toEqual({ height: '100px' })
    expect(resizePatch('se', { width: 230, height: 150 })).toEqual({ width: '230px', height: '150px' })
  })
  it('writes both axes when the ratio was kept', () => {
    expect(resizePatch('e', { width: 100, height: 50 }, { keepRatio: true })).toEqual({
      width: '100px',
      height: '50px',
    })
  })
})

describe('handles', () => {
  it('draw a grip in each corner and grab every edge', () => {
    expect(RESIZE_CORNERS).toEqual(['nw', 'ne', 'sw', 'se'])
    expect(RESIZE_EDGES).toEqual(['n', 'e', 's', 'w'])
    expect(handleAnchor('e')).toEqual({ x: 1, y: 0.5 })
    expect(handleAnchor('s')).toEqual({ x: 0.5, y: 1 })
    expect(handleAnchor('nw')).toEqual({ x: 0, y: 0 })
    expect(handleAnchor('se')).toEqual({ x: 1, y: 1 })
    expect(handleCursor('e')).toBe('ew-resize')
    expect(handleCursor('s')).toBe('ns-resize')
    expect(handleCursor('se')).toBe('nwse-resize')
    expect(handleCursor('ne')).toBe('nesw-resize')
  })
  it('labels the box size in whole pixels', () => {
    expect(sizeLabel({ width: 511.4, height: 638.6 })).toBe('511 × 639')
  })
})
