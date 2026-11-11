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
const { componentWriteNotes, runComponentTool } = await import('../server/componentTools.ts')

/**
 * What an agent hears right after a whole-frame write or a component write: blocks it wrote out
 * three times, colours the canvas has as tokens, a palette of its own on :root, and repeats
 * inside a component's main. An agent told us it skipped tokens and components because nothing
 * said so at the moment it mattered.
 */

const agent: Actor = { name: 'Claude', kind: 'agent', color: '#e5533c' }
const human: Actor = { name: 'Kevin', kind: 'user', color: '#2743ee' }

const row = (label: string, count: string) =>
  `<a class="nav-item" href="#"><img src="/a/x.svg" alt=""><span>${label}</span><span class="count">${count}</span></a>`
const page = (body: string, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`

function canvasWithTokens() {
  const canvasId = store.createCanvas('reuse', 'kevin').id
  actions.createTokens(
    canvasId,
    [
      { name: '--color-ink', type: 'color', value: '#111111' },
      { name: '--color-accent', type: 'color', value: '#E5533C' },
      { name: '--color-brand', type: 'color', value: 'var(--color-accent)' },
    ],
    human,
  )
  return canvasId
}

function write(canvasId: string, html: string, review = true) {
  const frame = actions.createFrame(canvasId, { name: 'Screen', html }, agent)!
  return componentWriteNotes(frame, { review })
}

describe('reuse notes on frame writes', () => {
  it('names a block written out three times, with the call that makes it a component', () => {
    const canvasId = canvasWithTokens()
    const notes = write(
      canvasId,
      page(`<nav>${row('Overview', '12')}${row('Files', '1,284')}${row('Trash', '3')}</nav>`),
    )
    const reuse = notes.filter((note) => note.startsWith('REUSE:'))
    expect(reuse).toHaveLength(1)
    expect(reuse[0]).toContain('3 blocks in this frame share one structure')
    expect(reuse[0]).toContain('replace_matching=true')
  })

  it('leaves two copies alone, and says nothing on a small edit', () => {
    const canvasId = canvasWithTokens()
    expect(write(canvasId, page(`<nav>${row('Overview', '12')}${row('Files', '9')}</nav>`))).toEqual([])
    const repeated = page(`<nav>${row('A', '1')}${row('B', '2')}${row('C', '3')}</nav>`)
    expect(write(canvasId, repeated, false)).toEqual([])
  })

  it('maps hardcoded colours to the tokens that hold them, aliases resolved', () => {
    const canvasId = canvasWithTokens()
    const notes = write(canvasId, page(`<h1 style="color:#111;border-color:#e5533c">Hi</h1>`))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('#111111 → var(--color-ink)')
    expect(notes[0]).toContain('#e5533c → var(--color-accent)')
  })

  it('does not count the token block Doop wrote into the frame', () => {
    const canvasId = canvasWithTokens()
    /* the frame names the token; the managed block it gets holds the literal */
    expect(write(canvasId, page(`<h1 style="color:var(--color-ink)">Hi</h1>`))).toEqual([])
    expect(store.getCanvas(canvasId)!.frames.at(-1)!.html).toContain('data-doop-tokens')
  })

  it('flags a palette declared on :root, and a token redefined there', () => {
    const own = write(
      canvasWithTokens(),
      page('<p>x</p>', '<style>:root{--ground:#f4f1ea;--ink:#1a1a1a;--lime:rgb(200 255 0)}</style>'),
    )
    expect(
      own.some((note) => note.includes('declares its own colour palette on :root (--ground, --ink, --lime)')),
    ).toBe(true)
    const clash = write(
      canvasWithTokens(),
      page('<p>x</p>', '<style>:root{--color-ink:#000;--color-accent:#f00;--x:#0f0}</style>'),
    )
    expect(clash.some((note) => note.includes('redefines canvas tokens on :root (--color-ink, --color-accent)'))).toBe(
      true,
    )
  })

  it('asks for tokens on a canvas with none once a frame hardcodes a palette', () => {
    const canvasId = store.createCanvas('bare', 'kevin').id
    const notes = write(
      canvasId,
      page(`<div style="background:#fff;color:#111;border:1px solid #ddd"><b style="color:#e5533c">x</b></div>`),
    )
    expect(notes).toEqual([expect.stringContaining('this canvas has no design tokens')])
    expect(write(store.createCanvas('bare', 'kevin').id, page(`<p style="color:#111">x</p>`))).toEqual([])
  })
})

describe('reuse notes stay accurate', () => {
  it('finds three rows repeated inside two matching panels', () => {
    const panel = `<section class="panel"><h2>Files</h2>${row('A', '1')}${row('B', '2')}${row('C', '3')}</section>`
    const notes = write(canvasWithTokens(), page(panel + panel))
    expect(notes.some((note) => note.startsWith('REUSE: 6 blocks'))).toBe(true)
  })

  it('does not suggest a token whose value changes under another theme', () => {
    const canvasId = store.createCanvas('themed', 'kevin').id
    actions.setTokenThemes(canvasId, ['dark'], human)
    actions.createTokens(
      canvasId,
      [
        { name: '--color-ink', type: 'color', value: '#111111', themes: { dark: '#ffffff' } },
        { name: '--color-line', type: 'color', value: '#dddddd' },
      ],
      human,
    )
    const notes = write(canvasId, page(`<p style="color:#111111;border-color:#dddddd">x</p>`))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('#dddddd → var(--color-line)')
    expect(notes[0]).not.toContain('--color-ink')
  })

  it('flags a single token redefined on :root, whatever its value', () => {
    const notes = write(canvasWithTokens(), page('<p>x</p>', '<style>:root{--color-ink:var(--other)}</style>'))
    expect(notes).toEqual([expect.stringContaining('redefines canvas tokens on :root (--color-ink)')])
  })

  it('reads colours from declarations only, not selectors, urls, strings or comments', () => {
    const canvasId = canvasWithTokens()
    const css =
      '<style>#e5533c{display:block} /* color:#111 */ .x{fill:url(#111);content:"#111"} a[href="#111"]{color:red}</style>'
    expect(write(canvasId, page('<p>x</p>', css))).toEqual([])
  })
})

describe('reuse inside components', () => {
  it('names rows a main repeats by hand, and what auto_props=false costs', () => {
    const canvasId = canvasWithTokens()
    const run = (name: string, input: Record<string, unknown>) => {
      const outcome = runComponentTool(name, input, {
        canvas: store.getCanvas(canvasId)!,
        actor: agent,
        canRead: () => true,
        readableCanvases: () => [],
      })
      if (!outcome.ok) throw new Error(outcome.error)
      return outcome.result
    }
    const created = run('create_component', {
      name: 'Sidebar',
      html: `<aside class="sb">${row('Overview', '12')}${row('Files', '1,284')}${row('Trash', '3')}</aside>`,
      css: '.sb{display:flex}',
      auto_props: false,
    })
    expect(created.note).toContain('3 elements inside “Sidebar” share one structure')
    expect(created.note).toContain('update_component “Sidebar” with a <doop-use> for each')
    expect(created.note).toContain('auto_props=false')
    /* built from nested instances, the same main says nothing */
    run('create_component', { name: 'NavItem', html: row('Overview', '12'), css: '.nav-item{display:flex}' })
    const nested = run('create_component', {
      name: 'Rail',
      html: `<aside class="rail"><doop-use component="NavItem"></doop-use><doop-use component="NavItem"></doop-use><doop-use component="NavItem"></doop-use></aside>`,
      css: '.rail{display:flex}',
    })
    expect(nested.note).not.toContain('REUSE')
  })
})
