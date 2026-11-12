import { describe, expect, it, vi } from 'vitest'
import type { Actor } from '../shared/types'

vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
  saveFrame: () => {},
  saveToken: () => {},
  deleteToken: () => {},
  saveComponent: () => {},
  saveCanvasCopy: async () => {},
  saveFrameVersion: () => {},
}))
vi.mock('../server/fonts.ts', () => ({ fontsForCanvas: () => [] }))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { existingStyle, existingStyleBrief } = await import('../server/existingStyle.ts')
const { COMPONENTS, DESIGN_BRIEF } = await import('../server/guide.ts')
const { runOperation } = await import('../server/workBudget.ts')
const { stubEnv, unstubAllEnvs } = await import('./envStub.ts')

/**
 * An agent asked for one more page on a canvas that already has a look should reuse that look:
 * the colours and fonts the pages share as tokens, the nav they all repeat as a component,
 * and the existing pages left alone until the human asks for the clean-up.
 */

const human: Actor = { name: 'Kevin', kind: 'user', color: '#2743ee' }

const nav = `<nav class="site-nav"><a class="brand" href="/">Acme</a><a class="link" href="/a">Pricing</a><a class="link" href="/b">Docs</a></nav>`
const screen = (title: string) =>
  `<!doctype html><html><head><style>body { font-family: 'Inter', sans-serif; color: #1A1A1A; background: #fafafa }
  .site-nav { display: flex; gap: 12px } h1 { color: #e5533c }</style></head>
  <body>${nav}<h1>${title}</h1><p style="color:#666">Copy</p></body></html>`

function canvasWithPages(count: number) {
  const canvasId = store.createCanvas('established', 'kevin').id
  for (let index = 0; index < count; index++)
    actions.createFrame(canvasId, { name: `Page ${index + 1}`, html: screen(`Page ${index + 1}`) }, human)
  return canvasId
}

describe('the existing style of a canvas', () => {
  it('says nothing about a canvas with one frame: that is a first frame, not a style', () => {
    expect(existingStyle(store.getCanvas(canvasWithPages(1))!)).toBeNull()
  })

  it('lists the colours and fonts the pages share and the blocks they repeat', () => {
    const style = existingStyle(store.getCanvas(canvasWithPages(3))!)!
    expect(style.frames).toBe(3)
    expect(style.colours).toEqual(
      expect.arrayContaining([
        { value: '#1a1a1a', frames: 3 },
        { value: '#e5533c', frames: 3 },
        { value: '#666666', frames: 3 },
      ]),
    )
    expect(style.fonts).toEqual([{ family: 'Inter', frames: 3 }])
    expect(style.repeated?.[0]).toMatchObject({ name: 'Site Nav', occurrences: 3, frames: 3 })
    expect(style.repeated?.[0]?.example.element).toContain('nav')
  })

  it('reads no palette once the canvas has tokens, and still names the repeats', () => {
    const canvasId = canvasWithPages(2)
    actions.createTokens(canvasId, [{ name: '--color-ink', type: 'color', value: '#1a1a1a' }], human)
    const style = existingStyle(store.getCanvas(canvasId)!)!
    expect(style.colours).toEqual([])
    expect(style.fonts).toEqual([])
    expect(style.repeated?.length).toBe(1)
  })

  it('finds a block two pages share even when one page repeats it inside a bigger one', () => {
    const canvasId = store.createCanvas('nested repeats', 'kevin').id
    const button = `<a class="cta" href="#"><span>Start</span><span>→</span></a>`
    const card = (title: string) => `<div class="card"><h3>${title}</h3><p>Copy</p>${button}</div>`
    const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`
    actions.createFrame(canvasId, { name: 'Plans', html: doc(card('Basic') + card('Pro')) }, human)
    actions.createFrame(canvasId, { name: 'Home', html: doc(`<h1>Hi</h1>${button}`) }, human)
    const repeated = existingStyle(store.getCanvas(canvasId)!)!.repeated!
    /* the cards sit on one page only: they are not a shared block, and must not hide the button */
    expect(repeated.map((block) => block.name)).toEqual(['Cta'])
    expect(repeated[0]).toMatchObject({ occurrences: 3, frames: 2 })
  })

  it('falls back to the tool, never fails the read, when the scan is out of work budget', () => {
    const canvasId = store.createCanvas('big pages', 'kevin').id
    const filler = '<p class="copy">' + 'word '.repeat(140_000) + '</p>'
    for (const name of ['One', 'Two'])
      actions.createFrame(canvasId, { name, html: screen(name).replace('</body>', `${filler}</body>`) }, human)
    stubEnv('DOOP_WORK_BUDGET_PARSE_MB', '1')
    try {
      const style = runOperation('mcp get_canvas', canvasId, () => existingStyle(store.getCanvas(canvasId)!))!
      expect(style.repeated).toBeUndefined()
      expect(style.colours.length).toBeGreaterThan(0)
      expect(existingStyleBrief(style, { tokens: false })).toContain('find_component_candidates')
    } finally {
      unstubAllEnvs()
    }
  })

  it('leaves out demo frames', () => {
    const canvasId = canvasWithPages(2)
    const canvas = store.getCanvas(canvasId)!
    canvas.frames[0]!.demo = true
    expect(existingStyle(canvas)).toBeNull()
  })

  it('briefs the agent to make tokens and components from the pages and to leave the pages alone', () => {
    const style = existingStyle(store.getCanvas(canvasWithPages(3))!)!
    const brief = existingStyleBrief(style, { tokens: false })
    expect(brief).toContain('#e5533c (3 frames)')
    expect(brief).toContain('Inter (3 frames)')
    expect(brief).toContain('create_tokens')
    expect(brief).toContain('“Site Nav” ×3 on 3 frames')
    expect(brief).toContain('no replace_matching')
    expect(existingStyleBrief(style, { tokens: true })).not.toContain('create_tokens')
  })

  it('points at find_component_candidates when the canvas is too big to scan', () => {
    const brief = existingStyleBrief({ frames: 40, colours: [], fonts: [] }, { tokens: true })
    expect(brief).toContain('find_component_candidates')
  })
})

describe('the guide on adding to an established canvas', () => {
  it('turns established frames into tokens and keeps replace_matching for an asked-for clean-up', () => {
    expect(DESIGN_BRIEF).toContain("get_canvas's existingStyle lists the colours")
    expect(DESIGN_BRIEF).toContain('Leave the existing frames as they are unless asked')
    expect(COMPONENTS).toContain('make the block a component from one existing copy')
    expect(COMPONENTS).toContain('use it when the human asked for that\n  clean-up')
  })
})
