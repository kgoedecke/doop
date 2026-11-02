import { describe, expect, it } from 'vitest'
import {
  aspectRatio,
  borderSummary,
  compactBox,
  colorAlpha,
  colorWithAlpha,
  lengthValue,
  rgbToHex,
  shorthandValue,
  sizeMode,
} from '../src/lib/cssValues'

describe('rgbToHex', () => {
  it('turns computed rgb triplets into hex', () => {
    expect(rgbToHex('rgb(255, 255, 255)')).toBe('#ffffff')
    expect(rgbToHex('rgba(229, 83, 60, 0.5)')).toBe('#e5533c')
  })
  it('treats a transparent colour as no colour', () => {
    expect(rgbToHex('rgba(0, 0, 0, 0)')).toBeNull()
    expect(rgbToHex('transparent')).toBeNull()
  })
  it('passes a hex through', () => {
    expect(rgbToHex('#ABCDEF')).toBe('#abcdef')
  })
})

describe('lengthValue', () => {
  it('gives bare numbers px and keeps units and keywords', () => {
    expect(lengthValue('20')).toBe('20px')
    expect(lengthValue('1.5rem')).toBe('1.5rem')
    expect(lengthValue('auto')).toBe('auto')
    expect(lengthValue('  ')).toBeNull()
  })
})

describe('shorthandValue', () => {
  it('builds a box shorthand from bare numbers', () => {
    expect(shorthandValue('20 14')).toBe('20px 14px')
    expect(shorthandValue('0')).toBe('0px')
    expect(shorthandValue('0 auto')).toBe('0px auto')
  })
  it('rejects junk and too many parts', () => {
    expect(shorthandValue('red')).toBeNull()
    expect(shorthandValue('1 2 3 4 5')).toBeNull()
  })
})

describe('compactBox', () => {
  it('folds four sides to the shortest shorthand', () => {
    expect(compactBox([8, 8, 8, 8])).toBe('8')
    expect(compactBox([20, 14, 20, 14])).toBe('20 14')
    expect(compactBox([1, 2, 3, 2])).toBe('1 2 3')
    expect(compactBox([1, 2, 3, 4])).toBe('1 2 3 4')
    expect(compactBox([null, null, null, null])).toBe('0')
  })
})

describe('sizeMode', () => {
  it('reads the inline length as one of the panel modes', () => {
    expect(sizeMode(undefined)).toBe('auto')
    expect(sizeMode('auto')).toBe('auto')
    expect(sizeMode('fit-content')).toBe('hug')
    expect(sizeMode('50%')).toBe('fixed')
    expect(sizeMode('calc(100% - 24px)')).toBe('fill')
    expect(sizeMode('100%')).toBe('fill')
    expect(sizeMode('236px')).toBe('fixed')
  })
})

describe('aspectRatio', () => {
  it('reads positive CSS ratios, including the optional auto keyword', () => {
    expect(aspectRatio('16 / 9')).toBeCloseTo(16 / 9)
    expect(aspectRatio('auto 1.5 / 1')).toBe(1.5)
    expect(aspectRatio('2')).toBe(2)
  })
  it('does not link automatic or degenerate ratios', () => {
    for (const value of ['auto', '', '0 / 1', '1 / 0', 'Infinity', '1 / 2 / 3']) {
      expect(aspectRatio(value)).toBeNull()
    }
  })
  it('uses natural image ratios only when the explicit ratio is an auto fallback', () => {
    expect(aspectRatio('auto 1 / 1', 2)).toBe(2)
    expect(aspectRatio('1 / 1', 2)).toBe(1)
    expect(aspectRatio('auto', 2)).toBeNull()
    expect(aspectRatio('auto 1 / 1', 0)).toBe(1)
  })
})

describe('borderSummary', () => {
  it('names the sides when the border is not all round', () => {
    expect(borderSummary([1, 1, 1, 1])).toEqual({ width: 1, sides: '' })
    expect(borderSummary([0, 1, 0, 0])).toEqual({ width: 1, sides: 'right' })
    expect(borderSummary([2, 0, 2, 0])).toEqual({ width: 2, sides: 'top bottom' })
    expect(borderSummary([null, null, null, null])).toEqual({ width: 0, sides: '' })
  })
})

describe('fill alpha', () => {
  it('keeps RGB channels when making a fill transparent and restores them', () => {
    const transparent = colorWithAlpha('#e5533c', 0)
    expect(colorAlpha(transparent)).toBe(0)
    expect(rgbToHex(transparent, true)).toBe('#e5533c')
    expect(colorWithAlpha(rgbToHex(transparent, true)!, 0.35)).toBe('rgba(229, 83, 60, 0.35)')
    expect(colorAlpha('rgb(255, 255, 255)')).toBe(1)
    expect(colorAlpha('oklch(0.6 .15 30 / 40%)')).toBe(0.4)
    expect(colorWithAlpha('oklch(0.6 .15 30 / .4)', 0.25)).toBe('rgb(from oklch(0.6 .15 30 / .4) r g b / 0.25)')
    expect(colorWithAlpha('#ffffff', 2)).toBe('rgba(255, 255, 255, 1)')
  })
})
