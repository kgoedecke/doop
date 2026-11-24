import { describe, expect, it } from 'vitest'
import { colorAlphaOf, logicalNames, matrixOf, px } from '../src/frame-runtime/cssValues'

describe('frame runtime CSS values', () => {
  it('reads a computed length to two decimals, and none as null', () => {
    expect(px('12.3456px')).toBe(12.35)
    expect(px('0')).toBe(0)
    expect(px('auto')).toBeNull()
    expect(px('')).toBeNull()
  })

  it("reads a 2D matrix's numbers and nothing else", () => {
    expect(matrixOf('matrix(1, 0, 0, 2, 10, 20)')).toEqual([1, 0, 0, 2, 10, 20])
    expect(matrixOf('none')).toBeNull()
    expect(matrixOf('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)')).toBeNull()
  })

  it("reads a computed colour's alpha in every notation a browser reports", () => {
    expect(colorAlphaOf('transparent')).toBe(0)
    expect(colorAlphaOf('')).toBe(0)
    expect(colorAlphaOf('rgb(1, 2, 3)')).toBe(1)
    expect(colorAlphaOf('rgba(1, 2, 3, 0.25)')).toBe(0.25)
    expect(colorAlphaOf('oklch(0.5 0.1 200 / 0)')).toBe(0)
    expect(colorAlphaOf('color(srgb 1 0 0 / 50%)')).toBe(0.5)
  })

  it('names every logical property that can stand for a physical side', () => {
    expect(logicalNames('width')).toEqual(['inline-size', 'block-size'])
    expect(logicalNames('max-height')).toEqual(['max-inline-size', 'max-block-size'])
    expect(logicalNames('padding-left')).toEqual([
      'padding-block-start',
      'padding-block-end',
      'padding-inline-start',
      'padding-inline-end',
    ])
    expect(logicalNames('border-top-color')).toContain('border-inline-start-color')
    expect(logicalNames('top')).toEqual([
      'inset-block-start',
      'inset-block-end',
      'inset-inline-start',
      'inset-inline-end',
    ])
    expect(logicalNames('border-bottom-right-radius')).toContain('border-end-end-radius')
    expect(logicalNames('color')).toEqual([])
  })
})
