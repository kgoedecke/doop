import { expect, it } from 'vitest'
import { backgroundTone, normalizePageBackground, relativeLuminance } from '../shared/pageBackground.ts'
import { paperOf } from '../src/lib/paper'

it('normalizes typed colours to a lowercase #rrggbb and refuses the rest', () => {
  expect(normalizePageBackground('#F5F5F5')).toBe('#f5f5f5')
  expect(normalizePageBackground(' 1e1e1e ')).toBe('#1e1e1e')
  expect(normalizePageBackground('#abc')).toBe('#aabbcc')
  expect(normalizePageBackground('#12345')).toBeNull()
  expect(normalizePageBackground('red')).toBeNull()
  expect(normalizePageBackground('#1e1e1e80')).toBeNull()
  expect(normalizePageBackground(null)).toBeNull()
  expect(normalizePageBackground(12)).toBeNull()
})

it('tells which ink reads on a colour', () => {
  expect(relativeLuminance('#ffffff')).toBeCloseTo(1)
  expect(relativeLuminance('#000000')).toBe(0)
  expect(backgroundTone('#f5f5f5')).toBe('light')
  expect(backgroundTone('#1e1e1e')).toBe('dark')
  expect(backgroundTone('#0a2540')).toBe('dark')
  expect(backgroundTone('#ffd166')).toBe('light')
})

it('shows a page its own colour, else the theme paper', () => {
  const canvas = {
    id: 'c',
    pages: [
      { id: 'p1', name: 'Painted', background: '#1e1e1e' },
      { id: 'p2', name: 'Plain' },
    ],
  }
  expect(paperOf(canvas, 'p1', 'light')).toEqual({ background: '#1e1e1e', tone: 'dark' })
  expect(paperOf(canvas, 'p2', 'light')).toEqual({ background: null, tone: 'light' })
  expect(paperOf(canvas, 'p2', 'dark')).toEqual({ background: null, tone: 'dark' })
  expect(paperOf(null, 'p1', 'dark')).toEqual({ background: null, tone: 'dark' })
})
