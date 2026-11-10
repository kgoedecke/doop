import { describe, expect, it } from 'vitest'
import { FRAME_PAPER_STYLE, withPaperRule } from '../shared/framePaper'

const SHELL = 'width: 100%; height: 100%; margin: 0px;'
const WHITE = 'background: rgb(255, 255, 255);'
/** a document as the Frame tool used to write it, with a design put inside */
const drawn = (content: string, { head = '', bodyStyle = `${SHELL} ${WHITE}`, htmlStyle = SHELL } = {}) =>
  `<!doctype html>\n<html style="${htmlStyle}"><head>${head}</head><body style="${bodyStyle}">${content}</body></html>`
const DARK_DESIGN = '<meta charset="utf-8"><style>*{margin:0}body{background:#101111;color:#fff}</style><main></main>'

describe('withPaperRule', () => {
  it('turns the old inline white into the rule a design can beat', () => {
    expect(withPaperRule(drawn(DARK_DESIGN))).toBe(drawn(DARK_DESIGN, { head: FRAME_PAPER_STYLE, bodyStyle: SHELL }))
  })

  it('keeps an empty drawn frame white, through the rule', () => {
    expect(withPaperRule(drawn(''))).toBe(drawn('', { head: FRAME_PAPER_STYLE, bodyStyle: SHELL }))
  })

  it('puts the rule ahead of whatever the head already holds', () => {
    const fonts = '<link rel="stylesheet" data-doop-webfonts href="https://fonts.example/css2">'
    expect(withPaperRule(drawn(DARK_DESIGN, { head: fonts }))).toBe(
      drawn(DARK_DESIGN, { head: FRAME_PAPER_STYLE + fonts, bodyStyle: SHELL }),
    )
  })

  it('settles: a healed document comes back as it is', () => {
    const healed = withPaperRule(drawn(DARK_DESIGN))
    expect(withPaperRule(healed)).toBe(healed)
  })

  it('leaves a white a design chose for itself alone', () => {
    for (const html of [
      '<html><head><style>body{background:#111}</style></head><body style="background:#fff"><main></main></body></html>',
      '<html><head></head><body style="background: rgb(255, 255, 255);"></body></html>',
      /* the white without the Frame tool's shell on html */
      drawn(DARK_DESIGN, { htmlStyle: 'height: 100%;' }),
      /* the shell with another colour */
      drawn(DARK_DESIGN, { bodyStyle: `${SHELL} background: rgb(250, 240, 230);` }),
      /* the white with more beside it */
      drawn(DARK_DESIGN, { bodyStyle: `${SHELL} ${WHITE} color: red;` }),
    ])
      expect(withPaperRule(html), html).toBe(html)
  })

  it('leaves fragments and plain documents alone', () => {
    for (const html of ['<main>fragment</main>', '<html><body><p>plain</p></body></html>', DARK_DESIGN, ''])
      expect(withPaperRule(html)).toBe(html)
  })

  it('touches nothing but the head and the body tag', () => {
    const card = `<div style="${WHITE}">card</div>`
    expect(withPaperRule(drawn(DARK_DESIGN + card))).toBe(
      drawn(DARK_DESIGN + card, { head: FRAME_PAPER_STYLE, bodyStyle: SHELL }),
    )
  })
})
