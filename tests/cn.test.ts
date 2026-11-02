import { describe, expect, it } from 'vitest'
import { cn } from '../src/lib/utils.ts'

/* The design system's named sizes and shapes must merge as what they are:
   a size beside a colour keeps both, two sizes keep the last. */
describe('cn with the design-system scale', () => {
  it('keeps a colour next to a named text size', () => {
    expect(cn('text-body', 'text-paper')).toBe('text-body text-paper')
    expect(cn('text-paper', 'text-body')).toBe('text-paper text-body')
  })

  it('lets a later named size replace an earlier one, and an arbitrary one', () => {
    expect(cn('text-[13px]', 'text-body')).toBe('text-body')
    expect(cn('text-body', 'md:text-title')).toBe('text-body md:text-title')
    expect(cn('text-sm', 'text-copy')).toBe('text-copy')
  })

  it('treats the named radii as radii', () => {
    expect(cn('rounded-md', 'rounded-pill')).toBe('rounded-pill')
    expect(cn('rounded-pill', 'rounded-full')).toBe('rounded-full')
    expect(cn('rounded-tag', 'rounded-full')).toBe('rounded-full')
    expect(cn('rounded-full', 'rounded-tag')).toBe('rounded-tag')
  })
})
