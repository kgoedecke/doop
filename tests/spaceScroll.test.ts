// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { spaceWouldScroll } from '../src/lib/spaceScroll'

/* happy-dom does no layout, so each box gets the metrics it would have */
function box(style: string, metrics: { scrollHeight: number; clientHeight: number; scrollTop?: number }) {
  const el = document.createElement('div')
  el.setAttribute('style', style)
  Object.defineProperty(el, 'scrollHeight', { value: metrics.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { value: metrics.clientHeight })
  Object.defineProperty(el, 'scrollTop', { value: metrics.scrollTop ?? 0 })
  return el
}

afterEach(() => {
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('style')
})

describe('spaceWouldScroll', () => {
  it('is false on a canvas that clips its overflow, so the pan leaves the key alone', () => {
    document.documentElement.setAttribute('style', 'overflow: hidden')
    const stage = box('overflow: hidden', { scrollHeight: 4000, clientHeight: 800 })
    document.body.append(stage)
    expect(spaceWouldScroll(stage, false)).toBe(false)
    expect(spaceWouldScroll(null, false)).toBe(false)
  })

  it('is true inside a scrolling list with room left that way', () => {
    document.documentElement.setAttribute('style', 'overflow: hidden')
    const list = box('overflow-y: auto', { scrollHeight: 900, clientHeight: 300, scrollTop: 100 })
    const row = document.createElement('div')
    list.append(row)
    document.body.append(list)
    expect(spaceWouldScroll(row, false)).toBe(true)
    expect(spaceWouldScroll(row, true)).toBe(true)
  })

  it('is false at the end the step would move towards', () => {
    document.documentElement.setAttribute('style', 'overflow: hidden')
    const top = box('overflow-y: auto', { scrollHeight: 900, clientHeight: 300 })
    const bottom = box('overflow-y: scroll', { scrollHeight: 900, clientHeight: 300, scrollTop: 600 })
    document.body.append(top, bottom)
    expect(spaceWouldScroll(top, true)).toBe(false)
    expect(spaceWouldScroll(bottom, false)).toBe(false)
  })
})
