import { beforeEach, describe, expect, it } from 'vitest'
import type { ComponentDef } from '../shared/components.ts'
import type { DesignToken } from '../shared/designTokens.ts'
import type { Canvas, Frame } from '../shared/types.ts'
import { legacyFrame, rememberTokens, restyledFrames, type SentFrames } from '../server/legacyFrames.ts'

/**
 * What a shared-style change sends to connections that cannot compose: the frames whose
 * composed document it altered, found without composing the ones it cannot reach.
 */

const token = (name: string, value: string): DesignToken => ({
  name,
  type: 'color',
  value,
  order: 0,
  updatedAt: 0,
  updatedBy: 't',
})
const button = {
  id: 'cbutton',
  name: 'Button',
  template: '<b data-doop-part="a"></b>',
  head: [],
} as unknown as ComponentDef
const frame = (id: string, html: string) => ({ id, canvasId: 'c', name: id, html }) as Frame

let canvas: Canvas
let viewers: { sent: SentFrames }[]

/** every viewer has been sent every frame, as an init does */
function sendAll() {
  for (const viewer of viewers) for (const f of canvas.frames) viewer.sent.set(f.id, legacyFrame(canvas, f).key)
}
const restyled = (change: Parameters<typeof restyledFrames>[1]) =>
  restyledFrames(canvas, change, viewers).map((entry) => [entry.frame.id, entry.to.length])

beforeEach(() => {
  canvas = {
    id: 'c',
    name: 'c',
    createdAt: 0,
    updatedAt: 0,
    tokens: [token('--ink', '#111'), token('--text', 'var(--ink)'), token('--brand', 'blue'), token('--idle', 'red')],
    components: [{ ...button, css: '.btn{color:var(--brand)}' }],
    frames: [
      frame('direct', '<p style="color:var(--ink)">a</p>'),
      frame('aliased', '<p style="color:var(--text)">a</p>'),
      frame('instance', '<b data-doop-instance="cbutton" data-doop-rev="1"></b>'),
      frame('plain', '<p>nothing shared</p>'),
    ],
  } as Canvas
  viewers = [{ sent: new Map() }, { sent: new Map() }]
  rememberTokens(canvas)
  sendAll()
})

const setToken = (name: string, value: string) => {
  canvas.tokens = canvas.tokens!.map((entry) => (entry.name === name ? { ...entry, value } : entry))
}

describe('restyledFrames', () => {
  it('sends the frames naming a changed token, an alias of it included, to every viewer once', () => {
    setToken('--ink', '#222')
    expect(restyled({ tokens: true })).toEqual([
      ['direct', 2],
      ['aliased', 2],
    ])
    /* they hold it now */
    expect(restyled({ tokens: true })).toEqual([])
  })

  it('reaches a frame through the rules of a component it uses', () => {
    setToken('--brand', 'green')
    expect(restyled({ tokens: true })).toEqual([['instance', 2]])
  })

  it('sends nothing for a token nothing names', () => {
    setToken('--idle', 'orange')
    expect(restyled({ tokens: true })).toEqual([])
  })

  it('sends the frames using a component whose rules changed, and no others', () => {
    canvas.components = [{ ...button, css: '.btn{color:var(--brand);padding:4px}' }]
    expect(restyled({ componentId: 'cbutton' })).toEqual([['instance', 2]])
  })

  it('carries the composed document', () => {
    setToken('--ink', '#222')
    const [first] = restyledFrames(canvas, { tokens: true }, viewers)
    expect(first!.frame.html).toContain('--ink:#222')
    expect(canvas.frames[0]!.html).not.toContain('data-doop-tokens')
  })

  it('leaves out a frame a viewer was never sent with its HTML', () => {
    viewers[1]!.sent.delete('direct')
    setToken('--ink', '#222')
    expect(restyled({ tokens: true })).toEqual([
      ['direct', 1],
      ['aliased', 2],
    ])
  })

  it('looks at every token-using frame when the themes change', () => {
    canvas.tokenThemes = ['dark']
    canvas.tokens = canvas.tokens!.map((entry) =>
      entry.name === '--idle' ? { ...entry, themes: { dark: 'black' } } : entry,
    )
    /* a theme block now rides with every token a frame names */
    expect(restyled({ tokens: true }).map(([id]) => id)).toEqual(['direct', 'aliased', 'instance'])
  })
})
