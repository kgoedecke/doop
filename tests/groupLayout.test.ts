// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { FLEX_ITEM_STYLE, flexItemStyle, groupStyle, planGroup } from '../src/lib/groupLayout'
import { groupElements, ungroupElements } from '../src/lib/layers'

const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`
const bodyOf = (html: string) => new DOMParser().parseFromString(html, 'text/html').body.innerHTML
const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

describe('planGroup', () => {
  it('stacks layers one above the other as a column, the space between them the gap', () => {
    /* two rects, 51×62, 22px apart */
    const plan = planGroup([rect(205, 109, 51, 62), rect(205, 25, 51, 62)])
    expect(plan).toEqual({ kind: 'flex', direction: 'column', gap: 22, align: 'start', order: [1, 0], x: 205, y: 25 })
  })

  it('lines a row up by the edge the layers share', () => {
    const plan = planGroup([rect(0, 10, 20, 20), rect(40, 0, 20, 40), rect(80, 5, 20, 30)])
    expect(plan).toMatchObject({ kind: 'flex', direction: 'row', gap: 20, align: 'center', order: [0, 1, 2] })
  })

  it('takes the wider spread when layers run both ways', () => {
    expect(planGroup([rect(0, 0, 10, 10), rect(100, 20, 10, 10)])).toMatchObject({ direction: 'row' })
    expect(planGroup([rect(0, 0, 10, 10), rect(20, 100, 10, 10)])).toMatchObject({ direction: 'column' })
  })

  it('pins overlapping layers where they are, unless auto layout is asked for', () => {
    const rects = [rect(0, 0, 50, 50), rect(30, 30, 50, 50)]
    expect(planGroup(rects)).toEqual({ kind: 'pinned', x: 0, y: 0, width: 80, height: 80 })
    expect(planGroup(rects, { flex: true })).toMatchObject({ kind: 'flex', gap: 0, order: [0, 1] })
  })

  it('writes the group box absolute where the layers were', () => {
    const plan = planGroup([rect(205, 25, 51, 62), rect(205, 109, 51, 62)])
    expect(groupStyle(plan, 205, 25)).toBe(
      'display: flex; flex-direction: column; align-items: start; gap: 22px; position: absolute; left: 205px; top: 25px; width: max-content',
    )
    expect(groupStyle({ kind: 'pinned', x: 0, y: 0, width: 80, height: 80 }, 4, 6)).toBe(
      'position: absolute; left: 4px; top: 6px; width: 80px; height: 80px',
    )
  })
})

describe('grouping drawn layers', () => {
  const a = 'body:nth-of-type(1) > div:nth-of-type(1)'
  const b = 'body:nth-of-type(1) > div:nth-of-type(2)'
  const shapes = doc(
    '<div style="position:absolute;left:205px;top:109px;width:51px;height:62px"></div>' +
      '<div style="position:absolute;left:205px;top:25px;width:51px;height:62px"></div>',
  )

  it('makes them flex items in flow order', () => {
    const grouped = groupElements(shapes, [b, a], {
      name: 'Group',
      style: 'display: flex',
      childStyle: FLEX_ITEM_STYLE,
      inGivenOrder: true,
    })
    expect(bodyOf(grouped!.html)).toBe(
      '<div data-doop-name="Group" style="display: flex">' +
        '<div style="width: 51px; height: 62px; flex-shrink: 0;"></div>' +
        '<div style="width: 51px; height: 62px; flex-shrink: 0;"></div></div>',
    )
  })

  it('places each freed layer where it was', () => {
    const grouped = doc('<div style="display:flex;position:absolute"><div></div><div></div></div>')
    const freed = ungroupElements(grouped, [a], {
      [`${a} > div:nth-of-type(2)`]: { position: 'absolute', left: '5px', top: '9px' },
    })
    expect(bodyOf(freed!.html)).toBe('<div></div><div style="position: absolute; left: 5px; top: 9px;"></div>')
  })
})

describe('flexItemStyle', () => {
  const el = (markup: string) => new DOMParser().parseFromString(markup, 'text/html').body.firstElementChild!

  it('sheds an inline placement', () => {
    expect(flexItemStyle(el('<div style="position:absolute;left:4px"></div>'))).toEqual(FLEX_ITEM_STYLE)
  })

  it('stays positioned when it holds layers placed absolute', () => {
    expect(
      flexItemStyle(el('<div style="position:absolute"><i style="position:absolute;left:3px"></i></div>')),
    ).toMatchObject({ position: 'relative', left: null })
  })

  it('overrides a placement a stylesheet gives it', () => {
    expect(flexItemStyle(el('<div class="pinned"></div>'))).toMatchObject({
      position: 'relative !important',
      left: 'auto !important',
    })
  })
})
