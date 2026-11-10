import { describe, expect, it } from 'vitest'
import { FRAME_PAPER_STYLE, stylesBodyBackground, withoutPaperOverride } from '../shared/framePaper'

const SHELL = 'width: 100%; height: 100%; margin: 0px;'
const WHITE = 'background: rgb(255, 255, 255);'
const legacy = (content: string, bodyStyle = `${SHELL} ${WHITE}`) =>
  `<!doctype html>\n<html style="${SHELL}"><head></head><body style="${bodyStyle}">${content}</body></html>`
const DARK_DESIGN = '<meta charset="utf-8"><style>*{margin:0}body{background:#101111;color:#fff}</style><main></main>'

describe('stylesBodyBackground', () => {
  const styled = (css: string) => `<html><head><style>${css}</style></head><body></body></html>`

  it('finds a rule whose subject is the body', () => {
    for (const css of [
      'body{background:#101111}',
      'html, body { background-color: black }',
      '*{margin:0}body.dark{background-image:linear-gradient(#000,#111)}',
      '@media (min-width:1px){ body { background: red } }',
    ])
      expect(stylesBodyBackground(styled(css)), css).toBe(true)
  })

  it('does not count the Frame tool paper itself', () => {
    expect(stylesBodyBackground(`<html><head>${FRAME_PAPER_STYLE}</head><body></body></html>`)).toBe(false)
  })

  it('passes over rules that are not the body getting a background', () => {
    for (const css of [
      'body{color:red}',
      'body > main{background:#000}',
      'tbody{background:#000}',
      '.body{background:#000}',
      '/* body{background:#000} */ main{background:#000}',
    ])
      expect(stylesBodyBackground(styled(css)), css).toBe(false)
  })
})

describe('withoutPaperOverride', () => {
  it('drops the inline white where the design styles the body itself', () => {
    const html = withoutPaperOverride(legacy(DARK_DESIGN))
    expect(html).toBe(legacy(DARK_DESIGN, SHELL))
  })

  it('reads the white in the forms a style attribute holds it', () => {
    for (const white of ['background: #ffffff;', 'background:#fff', 'background-color: rgb(255,255,255);'])
      expect(withoutPaperOverride(legacy(DARK_DESIGN, `${SHELL} ${white}`))).toBe(legacy(DARK_DESIGN, SHELL))
  })

  it('keeps the white of a drawn frame nothing has styled yet', () => {
    const empty = legacy('')
    expect(withoutPaperOverride(empty)).toBe(empty)
    const content = legacy('<style>main{background:#101111}</style><main></main>')
    expect(withoutPaperOverride(content)).toBe(content)
  })

  it('keeps a body background that is not the Frame tool white', () => {
    const tinted = legacy(DARK_DESIGN, `${SHELL} background: rgb(250, 240, 230);`)
    expect(withoutPaperOverride(tinted)).toBe(tinted)
  })

  it('leaves documents without a styled body, or without a body, alone', () => {
    for (const html of ['<main>fragment</main>', '<html><body><p>plain</p></body></html>', DARK_DESIGN])
      expect(withoutPaperOverride(html)).toBe(html)
  })

  it('touches nothing but the body tag', () => {
    const html = legacy(`${DARK_DESIGN}<div style="${WHITE}">card</div>`)
    expect(withoutPaperOverride(html)).toBe(legacy(`${DARK_DESIGN}<div style="${WHITE}">card</div>`, SHELL))
  })
})
