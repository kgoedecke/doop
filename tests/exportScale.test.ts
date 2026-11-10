import { describe, expect, it } from 'vitest'
import {
  exportPixelSize,
  exportScaleSuffix,
  fitExportScale,
  formatExportScale,
  MAX_EXPORT_PIXELS,
  MAX_EXPORT_SIDE,
  parseExportScale,
} from '../shared/exportScale'
import { readExportSettings } from '../src/lib/exportSettings'

describe('parseExportScale', () => {
  it('reads a multiplier as typed or sent', () => {
    expect(parseExportScale(2)).toBe(2)
    expect(parseExportScale('3')).toBe(3)
    expect(parseExportScale('1.5x')).toBe(1.5)
    expect(parseExportScale(' 0.5× ')).toBe(0.5)
    expect(parseExportScale('.75')).toBe(0.75)
    expect(parseExportScale('0,5')).toBe(0.5)
    expect(parseExportScale('1,5x')).toBe(1.5)
  })

  it('keeps two decimals, so the image cache sees a bounded set of keys', () => {
    expect(parseExportScale('1.23456')).toBe(1.23)
    expect(parseExportScale(2.999)).toBe(3)
  })

  it('refuses anything outside 0.1 to 4, or not a number', () => {
    for (const raw of ['0', '0.05', '4.5', '10', '-2', 'abc', '', '2px', '1e3', '1,2,3', undefined, null, ['2'], NaN]) {
      expect(parseExportScale(raw)).toBeNull()
    }
  })
})

describe('fitExportScale', () => {
  it('gives what was asked up to 2x, however large the frame, as every export did before', () => {
    expect(fitExportScale({ width: 1440, height: 30_000 }, 2)).toBe(2)
    expect(fitExportScale({ width: 1440, height: 30_000 }, 0.5)).toBe(0.5)
  })

  it('gives a poster or a slide the 4x it asked for', () => {
    expect(fitExportScale({ width: 1080, height: 1350 }, 4)).toBe(4)
    expect(fitExportScale({ width: 1920, height: 1080 }, 4)).toBe(4)
  })

  it('brings a large pick down to the pixel budget, never below 2x', () => {
    const page = { width: 1440, height: 6000 }
    const fitted = fitExportScale(page, 4)
    expect(fitted).toBeLessThan(4)
    expect(fitted).toBeGreaterThan(2)
    const { width, height } = exportPixelSize(page, fitted)
    expect(width * height).toBeLessThanOrEqual(MAX_EXPORT_PIXELS)
    expect(fitExportScale({ width: 1440, height: 20_000 }, 4)).toBe(2)
  })

  it('keeps the longest side drawable', () => {
    const strip = { width: 100, height: 5000 }
    const fitted = fitExportScale(strip, 4)
    expect(exportPixelSize(strip, fitted).height).toBeLessThanOrEqual(MAX_EXPORT_SIDE)
  })
})

it('names a scale and its file suffix as Figma does', () => {
  expect(formatExportScale(2)).toBe('2x')
  expect(formatExportScale(1.5)).toBe('1.5x')
  expect(exportScaleSuffix(1)).toBe('')
  expect(exportScaleSuffix(2)).toBe('@2x')
  expect(exportScaleSuffix(0.5)).toBe('@0.5x')
})

it('rounds output pixels the way the renderers do', () => {
  expect(exportPixelSize({ width: 1080, height: 1350 }, 2)).toEqual({ width: 2160, height: 2700 })
  expect(exportPixelSize({ width: 101, height: 3 }, 0.1)).toEqual({ width: 10, height: 1 })
})

describe('readExportSettings', () => {
  it('starts at 2x PNG', () => {
    expect(readExportSettings(null)).toEqual({ scale: 2, format: 'png' })
    expect(readExportSettings('not json')).toEqual({ scale: 2, format: 'png' })
  })

  it('keeps a stored pick and drops each field it cannot read on its own', () => {
    expect(readExportSettings('{"scale":3,"format":"svg"}')).toEqual({ scale: 3, format: 'svg' })
    expect(readExportSettings('{"scale":99,"format":"jpg"}')).toEqual({ scale: 2, format: 'jpg' })
    expect(readExportSettings('{"scale":1.5,"format":"gif"}')).toEqual({ scale: 1.5, format: 'png' })
  })
})
