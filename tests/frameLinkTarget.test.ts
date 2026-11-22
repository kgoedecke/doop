// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { resolveFrameLink } from '../src/lib/elementLink'
import type { Canvas, Frame } from '../shared/types'

const frame = (id: string, hidden = false): Frame => ({
  id,
  canvasId: 'c',
  name: id,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: '',
  hidden,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Tester',
})

const canvas: Canvas = {
  id: 'c',
  name: 'Canvas',
  pages: [
    { id: 'first', name: 'Page 1' },
    { id: 'second', name: 'Flows' },
  ],
  frames: [frame('target'), frame('hidden', true)],
  createdAt: 0,
  updatedAt: 0,
}

const resolve = (href: string) => resolveFrameLink(canvas, href)

describe('where ⌘-clicking a link in a frame goes', () => {
  it('moves to a frame or element of the open canvas, relative or absolute', () => {
    expect(resolve('/c/c?frame=target&element=abc123')).toMatchObject({
      kind: 'frame',
      frame: { id: 'target' },
      element: 'abc123',
    })
    expect(resolve(`${location.origin}/c/c?frame=target`)).toMatchObject({ kind: 'frame', element: null })
  })

  it('switches to a page of the open canvas, the frame winning when a link names both', () => {
    expect(resolve('/c/c?page=second')).toEqual({ kind: 'page', pageId: 'second' })
    expect(resolve(`${location.origin}/c/c?page=first`)).toEqual({ kind: 'page', pageId: 'first' })
    expect(resolve('/c/c?page=second&frame=target')).toMatchObject({ kind: 'frame', frame: { id: 'target' } })
    expect(resolve('/c/c?page=deleted')).toBeNull()
    // the canvas itself opens its default page, as the link would
    expect(resolve('/c/c')).toEqual({ kind: 'page', pageId: 'first' })
  })

  it('goes nowhere for a frame that is missing or hidden', () => {
    expect(resolve('/c/c?frame=gone')).toBeNull()
    expect(resolve('/c/c?frame=hidden')).toBeNull()
  })

  it('opens what a browser would open, relative paths and mail links included', () => {
    expect(resolve('https://example.com/pricing')).toEqual({ kind: 'web', url: 'https://example.com/pricing' })
    expect(resolve(' HTTP://example.com')).toEqual({ kind: 'web', url: 'http://example.com/' })
    expect(resolve(`${location.origin}/c/other?frame=target`)).toMatchObject({ kind: 'web' })
    expect(resolve('/pricing')).toEqual({ kind: 'web', url: `${location.origin}/pricing` })
    expect(resolve('pricing.html')).toEqual({ kind: 'web', url: `${location.origin}/pricing.html` })
    expect(resolve('mailto:hi@example.test')).toEqual({ kind: 'web', url: 'mailto:hi@example.test' })
    expect(resolve('tel:+15551234')).toEqual({ kind: 'web', url: 'tel:+15551234' })
  })

  it('scrolls the frame for a link to a spot in its own document', () => {
    expect(resolve('#')).toEqual({ kind: 'anchor', id: '' })
    expect(resolve(' #pricing')).toEqual({ kind: 'anchor', id: 'pricing' })
  })

  it('never follows a scheme that would run or show the design outside its sandbox', () => {
    for (const href of ['javascript:alert(1)', 'JavaScript:void 0', 'data:text/html,hi', 'blob:x', 'file:///etc/hosts'])
      expect(resolve(href)).toBeNull()
  })
})
