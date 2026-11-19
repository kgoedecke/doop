import { describe, expect, it } from 'vitest'
import { commentLink } from '../src/lib/commentLink.ts'

const origin = 'https://doop.test'

describe('commentLink', () => {
  it('opens a frame comment on its frame', () => {
    expect(commentLink({ id: 'k1', canvasId: 'c1', frameId: 'f1' }, origin)).toBe(
      'https://doop.test/c/c1?frame=f1&comment=k1',
    )
  })

  it('opens a canvas comment on its page', () => {
    expect(commentLink({ id: 'k1', canvasId: 'c1', pageId: 'p1' }, origin)).toBe(
      'https://doop.test/c/c1?page=p1&comment=k1',
    )
  })

  it('names the root for a reply, since only roots have pins', () => {
    expect(commentLink({ id: 'r1', parentId: 'k1', canvasId: 'c1', frameId: 'f1' }, origin)).toContain('comment=k1')
  })
})
