import { describe, expect, it } from 'vitest'
import type { ComponentDef } from '../shared/components'
import type { Canvas, Frame } from '../shared/types'
import { arrivedDeliverable } from '../src/lib/composerFlight'

const frame = (id: string, pageId?: string): Frame => ({
  id,
  canvasId: 'c',
  pageId,
  name: id,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: '',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Tester',
})

const canvas = (frames: Frame[], components: ComponentDef[] = []): Canvas => ({
  id: 'c',
  name: 'Canvas',
  pages: [
    { id: 'first', name: 'Page 1' },
    { id: 'parts', name: 'Components' },
  ],
  frames,
  components,
  createdAt: 0,
  updatedAt: 0,
})

const def = (id: string, mainFrameId: string | null) => ({ id, name: id, mainFrameId }) as ComponentDef
const known = new Set(['home'])

describe('the frame a composer submit flies to', () => {
  it('is the first frame that was not there before', () => {
    expect(arrivedDeliverable(canvas([frame('home', 'first'), frame('landing', 'first')]), known)?.id).toBe('landing')
  })

  it('waits while nothing new has arrived', () => {
    expect(arrivedDeliverable(canvas([frame('home', 'first')]), known)).toBeUndefined()
  })

  it('passes over a component main on the Components page, even before its component arrives', () => {
    expect(arrivedDeliverable(canvas([frame('home', 'first'), frame('button', 'parts')]), known)).toBeUndefined()
  })

  it('passes over a component main on any other page', () => {
    const c = canvas([frame('home', 'first'), frame('card', 'first'), frame('landing', 'first')], [def('Card', 'card')])
    expect(arrivedDeliverable(c, known)?.id).toBe('landing')
  })
})
