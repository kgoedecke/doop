import { describe, expect, it } from 'vitest'
import { DESIGN_PROPERTY_KEYS, normalizeDesignValue, splitCssList } from '../src/lib/designProperties'
import { readGradient, readShadow, writeGradient, writeShadow } from '../src/lib/designPaints'

describe('design property values', () => {
  it('adds units only for bare numeric lengths and angles', () => {
    expect(normalizeDesignValue('width', ' 16 ')).toBe('16px')
    expect(normalizeDesignValue('rotate', '-12.5')).toBe('-12.5deg')
    expect(normalizeDesignValue('opacity', '.5')).toBe('.5')
    expect(normalizeDesignValue('line-height', '1.5')).toBe('1.5')
  })
  it.each(['50%', 'var(--space)', 'calc(100% - 24px)', 'auto', 'fit-content', '2rem', ''])(
    'preserves authored value %s',
    (value) => {
      expect(normalizeDesignValue('width', value)).toBe(value)
    },
  )
  it('rejects unsupported properties', () => {
    expect(() => normalizeDesignValue('behavior', 'url(script)')).toThrow('not editable')
  })
  it('has one control per CSS property', () => {
    expect(new Set(DESIGN_PROPERTY_KEYS).size).toBe(DESIGN_PROPERTY_KEYS.length)
  })
})

describe('CSS paint stacks', () => {
  it('round trips browser-normalized shadows with the color first', () => {
    const shadow = readShadow('rgba(0, 0, 0, 0.2) 0px 4px 16px 0px inset')!
    expect(shadow).toEqual({
      color: 'rgba(0, 0, 0, 0.2)',
      x: '0px',
      y: '4px',
      blur: '16px',
      spread: '0px',
      inset: true,
    })
    expect(writeShadow({ ...shadow, blur: '24' })).toBe('inset 0px 4px 24px 0px rgba(0, 0, 0, 0.2)')
  })
  it('preserves complex shadows as CSS instead of misreading length functions', () => {
    expect(readShadow('calc(1em + 2px) 4px 8px var(--shadow)')).toBeNull()
  })
  it('expands implicit gradient stops and edits them independently', () => {
    const gradient = readGradient('linear-gradient(45deg, rgb(1, 2, 3), #fff)')!
    expect(gradient.stops).toEqual([
      { color: 'rgb(1, 2, 3)', position: '0%' },
      { color: '#fff', position: '100%' },
    ])
    expect(writeGradient({ ...gradient, direction: '90deg' })).toBe(
      'linear-gradient(90deg, rgb(1, 2, 3) 0%, #fff 100%)',
    )
  })
  it('keeps mixed gradient stop positions in the CSS editor', () => {
    expect(readGradient('linear-gradient(red 20%, white, blue 90%)')).toBeNull()
  })
  it('keeps nested gradient and rgba commas inside their layers', () => {
    expect(
      splitCssList('linear-gradient(45deg, rgba(0, 0, 0, .2), var(--fill, #fff)), radial-gradient(red, blue)'),
    ).toEqual(['linear-gradient(45deg, rgba(0, 0, 0, .2), var(--fill, #fff))', 'radial-gradient(red, blue)'])
  })
  it('preserves data URLs and escaped quotes', () => {
    expect(splitCssList('url("data:image/svg+xml,a,b"), url("a\\"b,c")')).toEqual([
      'url("data:image/svg+xml,a,b")',
      'url("a\\"b,c")',
    ])
  })
  it('splits inner and outer shadows independently', () => {
    expect(splitCssList('inset 0 2px 4px rgb(0, 0, 0), 0 8px 16px #0004')).toHaveLength(2)
  })
  it.each(['', 'none', ' none '])('treats %s as an empty stack', (value) => expect(splitCssList(value)).toEqual([]))
})
