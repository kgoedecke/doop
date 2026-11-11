import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
}))

import { store } from '../server/store.ts'
import * as actions from '../server/actions.ts'
import { blankComponent, contextFor } from '../server/components.ts'
import { compactDocument } from '../server/componentEngine.ts'
import { findComponentCandidates, lookalikesIn } from '../server/componentActions.ts'
import { COMPONENT_ATTR, INSTANCE_ATTR } from '../shared/components.ts'
import type { Actor } from '../shared/types.ts'

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor

const doc = (body: string, css = '') =>
  `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`

const BUTTON_CSS = `body { font-family: Inter; color: #111 }
:root { --accent: #0a7; --unused: 1 }
.btn { background: var(--accent); padding: 8px }
.btn[data-tone="ghost"] { background: none }
.page .btn:hover { opacity: .8 }
.other { color: red }`

/** A main button on one frame; returns everything a test needs. */
function setup() {
  const canvas = store.createCanvas('components test')
  const def = blankComponent({
    name: 'Button',
    by: 'Tester',
    props: [{ name: 'tone', type: 'enum', options: ['primary', 'ghost'], default: 'primary' }],
  })
  store.saveComponent(canvas.id, def)
  const mainFrame = actions.createFrame(canvas.id, { name: 'Main', html: '' }, actor)!
  actions.updateFrame(
    mainFrame.id,
    {
      html: doc(
        `<main class="page"><button class="btn" ${COMPONENT_ATTR}="${def.id}"><span class="icon" data-doop-if="icon">★</span><span class="label" data-doop-prop="label">Buy now</span></button></main>`,
        BUTTON_CSS,
      ),
    },
    actor,
  )
  const page = actions.createFrame(canvas.id, { name: 'Page', html: '' }, actor)!
  return { canvas, def, mainFrame, page }
}

const current = (canvasId: string, id: string) => store.getComponents(canvasId).find((d) => d.id === id)!
const framed = (id: string) => store.getFrame(id)!.html

describe('a main element', () => {
  it('becomes a template with keys, props and only the CSS it uses', () => {
    const { canvas, def } = setup()
    const saved = current(canvas.id, def.id)
    expect(saved.rev).toBe(1)
    expect(saved.template).not.toContain(COMPONENT_ATTR)
    expect(saved.template).toContain('data-doop-part')
    expect(saved.props.map((p) => p.name).sort()).toEqual(['icon', 'label', 'tone'])
    expect(saved.css).toContain('.btn')
    expect(saved.css).not.toContain('.other')
    expect(saved.css).toContain('--accent: #0a7')
    expect(saved.css).not.toContain('--unused')
    /* an ancestor outside the main is cut; the hover rule survives */
    expect(saved.css).not.toContain('.page')
    expect(saved.css).toContain(':hover')
    /* the frame's inherited type goes along */
    expect(saved.css).toContain('font-family: Inter')
    expect(saved.css).toContain(`[${INSTANCE_ATTR}="${def.id}"]`)
  })

  it('copied elsewhere is an instance, not a second main', () => {
    const { canvas, def, mainFrame, page } = setup()
    const mainHtml = /<button[\s\S]*<\/button>/.exec(framed(mainFrame.id))![0]
    actions.updateFrame(page.id, { html: doc(mainHtml) }, actor)
    expect(framed(page.id)).toContain(`${INSTANCE_ATTR}="${def.id}"`)
    expect(framed(page.id)).not.toContain(`${COMPONENT_ATTR}="`)
    expect(current(canvas.id, def.id).mainFrameId).toBe(mainFrame.id)
  })
})

describe('<doop-use>', () => {
  it('expands to full markup with props, enum on the root and CSS in the head', () => {
    const { def, page } = setup()
    actions.updateFrame(
      page.id,
      { html: doc(`<doop-use component="button" label="Sign up" tone="ghost"/><p>after</p>`) },
      actor,
    )
    const html = framed(page.id)
    expect(html).toContain('Sign up')
    expect(html).toContain('data-tone="ghost"')
    expect(html).toContain(`data-doop-component-css="${def.id}"`)
    expect(html).toContain('<p>after</p>')
    expect(html).not.toContain('doop-use')
    /* `icon` has no value here and defaults true: conditions see the default */
    expect(html).toContain('★')
    expect(actions.takeComponentIssues(page.id)).toEqual([])
  })

  it('reports what it could not do instead of guessing', () => {
    const { page } = setup()
    actions.updateFrame(
      page.id,
      {
        html: doc(
          `<doop-use component="Buton"></doop-use><doop-use component="Button" tone="neon" lable="x"></doop-use>`,
        ),
      },
      actor,
    )
    const messages = actions.takeComponentIssues(page.id).map((issue) => issue.message)
    expect(messages.some((m) => m.includes('no component “Buton”'))).toBe(true)
    expect(messages.some((m) => m.includes('primary | ghost'))).toBe(true)
    expect(messages.some((m) => m.includes('no prop “lable”') && m.includes('label'))).toBe(true)
  })

  it('survives a table, where a parser would throw it out', () => {
    const { canvas, page } = setup()
    const row = blankComponent({ name: 'Row', by: 'Tester' })
    store.saveComponent(canvas.id, row)
    const mainFrame = actions.createFrame(canvas.id, { name: 'RowMain', html: '' }, actor)!
    actions.updateFrame(
      mainFrame.id,
      {
        html: doc(
          `<table><tbody><tr ${COMPONENT_ATTR}="${row.id}"><td data-doop-prop="cell">x</td></tr></tbody></table>`,
        ),
      },
      actor,
    )
    actions.updateFrame(
      page.id,
      { html: doc(`<table><tbody><doop-use component="Row" cell="A"></doop-use></tbody></table>`) },
      actor,
    )
    expect(framed(page.id)).toMatch(/<tbody><tr[^>]*><td[^>]*>A<\/td><\/tr><\/tbody>/)
  })

  it('round-trips: compact, write back, same document', () => {
    const { canvas, page } = setup()
    actions.updateFrame(
      page.id,
      { html: doc(`<doop-use component="Button" label="One" tone="ghost" id="abc123"></doop-use>`) },
      actor,
    )
    const full = framed(page.id)
    const compact = compactDocument(full, contextFor(canvas.id))
    expect(compact).toContain('<doop-use component="Button" id="abc123" label="One" tone="ghost"></doop-use>')
    expect(compact).not.toContain('data-doop-part')
    expect(compact).not.toContain('.btn')
    expect(compact.length).toBeLessThan(full.length / 2)
    actions.updateFrame(page.id, { html: compact }, actor)
    expect(framed(page.id)).toBe(full)
  })
})

describe('propagation', () => {
  it('reaches every instance and keeps props and overrides', () => {
    const { canvas, def, mainFrame, page } = setup()
    actions.updateFrame(
      page.id,
      { html: doc(`<doop-use component="Button" label="Keep me" id="abc123"></doop-use>`) },
      actor,
    )
    const edited = framed(page.id).replace('<button class="btn"', '<button class="btn" title="mine"')
    actions.updateFrame(page.id, { html: edited }, actor)
    expect(framed(page.id)).toContain('title="mine"')

    const newMain = framed(mainFrame.id)
      .replace('<span class="label"', '<em class="new">new</em><span class="label"')
      .replace('background: var(--accent)', 'background: rebeccapurple')
    actions.updateFrame(mainFrame.id, { html: newMain }, actor)

    expect(current(canvas.id, def.id).rev).toBe(2)
    const html = framed(page.id)
    expect(html).toContain('class="new"')
    expect(html).toContain('Keep me')
    expect(html).toContain('title="mine"')
    expect(html).toContain('rebeccapurple')
    expect(html).toContain('data-doop-rev="2"')
  })

  it('withdraws sign-off on a frame that changed', () => {
    const { mainFrame, page } = setup()
    actions.updateFrame(page.id, { html: doc(`<doop-use component="Button"></doop-use>`) }, actor)
    actions.setFrameApproval(page.id, true, { id: 'u', name: 'Reviewer' })
    actions.updateFrame(mainFrame.id, { html: framed(mainFrame.id).replace('Buy now', 'Buy today') }, actor)
    expect(store.getFrame(page.id)!.approval?.status).toBe('needs_review')
  })

  it('does not treat a stale save as overrides: it merges', () => {
    const { mainFrame, page } = setup()
    actions.updateFrame(page.id, { html: doc(`<doop-use component="Button" label="Mine"></doop-use>`) }, actor)
    /* a client still holding revision 1 ... */
    const stale = framed(page.id)
    /* ... while the main moves on */
    actions.updateFrame(
      mainFrame.id,
      { html: framed(mainFrame.id).replace('<button class="btn"', '<button class="btn fresh"') },
      actor,
    )
    /* ... saves with one real edit */
    actions.updateFrame(page.id, { html: stale.replace('</span></button>', '</span></button><p>added</p>') }, actor)
    const html = framed(page.id)
    expect(html).toContain('btn fresh')
    expect(html).toContain('<p>added</p>')
    expect(html).toContain('data-doop-rev="2"')
    expect(html).not.toContain('data-doop-overrides')
  })

  it('catches instances up when a nested component changes', () => {
    const { canvas, mainFrame, page } = setup()
    const card = blankComponent({ name: 'Card', by: 'Tester' })
    store.saveComponent(canvas.id, card)
    const cardFrame = actions.createFrame(canvas.id, { name: 'CardMain', html: '' }, actor)!
    actions.updateFrame(
      cardFrame.id,
      {
        html: doc(
          `<div class="card" ${COMPONENT_ATTR}="${card.id}"><h2>Title</h2><doop-use component="Button" label="Inside"></doop-use></div>`,
        ),
      },
      actor,
    )
    actions.updateFrame(page.id, { html: doc(`<doop-use component="Card"></doop-use>`) }, actor)
    expect(framed(page.id)).toContain('Inside')
    actions.updateFrame(
      mainFrame.id,
      { html: framed(mainFrame.id).replace('<button class="btn"', '<button class="btn nested-fresh"') },
      actor,
    )
    expect(framed(page.id)).toContain('nested-fresh')
    expect(framed(page.id)).toContain('Inside')
  })
})

describe('edits inside an instance', () => {
  function placed() {
    const made = setup()
    actions.updateFrame(made.page.id, { html: doc(`<doop-use component="Button" id="abc123"></doop-use>`) }, actor)
    return made
  }

  it('route to the prop when the element is bound', () => {
    const { page } = placed()
    actions.updateFrame(page.id, { html: framed(page.id).replace('Buy now', 'Changed') }, actor)
    expect(framed(page.id)).toMatch(/data-doop-props="[^"]*label[^"]*Changed/)
    expect(framed(page.id)).not.toContain('data-doop-overrides')
  })

  it('route to the enum when its root attribute changes', () => {
    const { page } = placed()
    actions.updateFrame(page.id, { html: framed(page.id).replace('data-tone="primary"', 'data-tone="ghost"') }, actor)
    expect(framed(page.id)).toMatch(/data-doop-props="[^"]*tone[^"]*ghost/)
  })

  it('keep style changes per property and drop one set back to the template', () => {
    const { page } = placed()
    const styled = framed(page.id).replace('<button class="btn"', '<button style="color: red; margin: 2px" class="btn"')
    actions.updateFrame(page.id, { html: styled }, actor)
    expect(framed(page.id)).toContain('data-doop-overrides')
    const back = framed(page.id).replace(/ style="[^"]*"/, '')
    actions.updateFrame(page.id, { html: back }, actor)
    expect(framed(page.id)).not.toContain('data-doop-overrides')
  })

  it('hide a deleted element instead of cutting the link', () => {
    const { def, mainFrame, page } = placed()
    actions.updateFrame(page.id, { html: framed(page.id).replace(/<span class="icon"[^>]*>★<\/span>/, '') }, actor)
    const html = framed(page.id)
    expect(html).toContain(`${INSTANCE_ATTR}="${def.id}"`)
    expect(html).not.toContain('★')
    expect(html).toContain('hidden')
    /* and it stays hidden through an update */
    actions.updateFrame(mainFrame.id, { html: framed(mainFrame.id).replace('★', '☆') }, actor)
    expect(framed(page.id)).not.toContain('☆')
  })

  it('keep a structural change on that element alone, still linked', () => {
    const { def, mainFrame, page } = placed()
    actions.updateFrame(
      page.id,
      { html: framed(page.id).replace('</span></button>', '</span><b>extra</b></button>') },
      actor,
    )
    expect(framed(page.id)).toContain('<b>extra</b>')
    expect(framed(page.id)).toContain(`${INSTANCE_ATTR}="${def.id}"`)
    actions.updateFrame(
      mainFrame.id,
      { html: framed(mainFrame.id).replace('<button class="btn"', '<button class="btn outer-fresh"') },
      actor,
    )
    expect(framed(page.id)).toContain('outer-fresh')
    expect(framed(page.id)).toContain('<b>extra</b>')
  })

  it('leave an unchanged document byte-identical', () => {
    const { page } = placed()
    const before = framed(page.id)
    actions.updateFrame(page.id, { html: before }, actor)
    expect(framed(page.id)).toBe(before)
  })
})

describe('slots', () => {
  it('hold instance content through updates, nested instances included', () => {
    const { canvas, page } = setup()
    const card = blankComponent({ name: 'Card', by: 'Tester' })
    store.saveComponent(canvas.id, card)
    const cardFrame = actions.createFrame(canvas.id, { name: 'CardMain', html: '' }, actor)!
    actions.updateFrame(
      cardFrame.id,
      {
        html: doc(
          `<section ${COMPONENT_ATTR}="${card.id}"><h2 data-doop-prop="title">T</h2><div data-doop-slot="actions" data-doop-slot-suggest="Button"></div></section>`,
        ),
      },
      actor,
    )
    expect(current(canvas.id, card.id).slots).toEqual([{ name: 'actions', suggested: ['Button'] }])
    actions.updateFrame(
      page.id,
      {
        html: doc(
          `<doop-use component="Card" title="Hi"><doop-use slot="actions" component="Button" label="In slot"></doop-use></doop-use>`,
        ),
      },
      actor,
    )
    const html = framed(page.id)
    expect(html).toContain('In slot')
    expect(html).not.toContain('doop-use')
    const compact = compactDocument(html, contextFor(canvas.id))
    expect(compact).toContain('<template slot="actions">')
    expect(compact).toContain('label="In slot"')

    actions.updateFrame(cardFrame.id, { html: framed(cardFrame.id).replace('<h2 ', '<h2 class="fresh" ') }, actor)
    const after = framed(page.id)
    expect(after).toContain('class="fresh"')
    expect(after).toContain('In slot')
  })
})

describe('losing things', () => {
  it('a main removed leaves its instances working, and undo gives it back', () => {
    const { canvas, def, mainFrame, page } = setup()
    actions.updateFrame(page.id, { html: doc(`<doop-use component="Button"></doop-use>`) }, actor)
    const withMain = framed(mainFrame.id)
    actions.updateFrame(mainFrame.id, { html: doc('<p>gone</p>') }, actor)
    expect(current(canvas.id, def.id).mainFrameId).toBeNull()
    expect(framed(page.id)).toContain('Buy now')
    actions.updateFrame(mainFrame.id, { html: withMain }, actor)
    expect(current(canvas.id, def.id).mainFrameId).toBe(mainFrame.id)
  })

  it('refuses a component inside itself', () => {
    const { canvas } = setup()
    const box = blankComponent({ name: 'Box', by: 'Tester' })
    store.saveComponent(canvas.id, box)
    const frame = actions.createFrame(canvas.id, { name: 'BoxMain', html: '' }, actor)!
    actions.updateFrame(frame.id, { html: doc(`<div ${COMPONENT_ATTR}="${box.id}"><p>x</p></div>`) }, actor)
    const before = current(canvas.id, box.id).rev
    actions.updateFrame(
      frame.id,
      { html: framed(frame.id).replace('</p>', `</p><doop-use component="Box"></doop-use>`) },
      actor,
    )
    expect(current(canvas.id, box.id).rev).toBe(before)
    expect(actions.takeComponentIssues(frame.id).some((i) => i.code === 'nesting_cycle')).toBe(true)
  })

  it('tells an agent when a rewrite dropped instances', () => {
    const { page } = setup()
    actions.updateFrame(page.id, { html: doc(`<doop-use component="Button"></doop-use>`) }, actor)
    actions.updateFrame(page.id, { html: doc('<button>flat</button>') }, actor)
    expect(actions.takeComponentIssues(page.id).some((i) => i.code === 'instance_removed')).toBe(true)
  })
})

describe('hostile markup', () => {
  const deep = (depth: number, inner: string) => `${'<div>'.repeat(depth)}${inner}${'</div>'.repeat(depth)}`

  it('saves markup nested past the call stack, around a component or inside a main', () => {
    const { canvas, def, page } = setup()
    const around = doc(deep(20_000, `<doop-use component="Button"></doop-use>`))
    expect(actions.updateFrame(page.id, { html: around }, actor)).toBeDefined()
    expect(lookalikesIn(store.getFrame(page.id)!)).toEqual([])
    expect(findComponentCandidates(store.getCanvas(canvas.id)!).length).toBeGreaterThanOrEqual(0)

    const main = actions.createFrame(canvas.id, { name: 'Deep', html: '' }, actor)!
    const before = current(canvas.id, def.id).rev
    const inside = doc(`<div ${COMPONENT_ATTR}="${def.id}">${deep(20_000, 'x')}</div>`)
    expect(actions.updateFrame(main.id, { html: inside }, actor)).toBeDefined()
    expect(current(canvas.id, def.id).rev).toBe(before)
    // about six seconds alone, and past thirty when the whole suite is running
  }, 120_000)
})

describe('streaming', () => {
  it('renders instances chunk by chunk and settles the head at the end', () => {
    const { def, page } = setup()
    actions.appendFrameHtml(page.id, '<!doctype html><html><head><title>x</title></head><body>', actor, { start: true })
    actions.appendFrameHtml(page.id, '<doop-use component="Button" label="Streamed"></doop-use>', actor)
    expect(framed(page.id)).toContain('Streamed')
    actions.appendFrameHtml(page.id, '</body></html>', actor, { done: true })
    const html = framed(page.id)
    expect(html.indexOf(`data-doop-component-css="${def.id}"`)).toBeLessThan(html.indexOf('</head>'))
    expect(html.match(/data-doop-component-css=/g)).toHaveLength(1)
  })
})

beforeEach(() => {
  for (const c of store.allCanvases()) store.canvases.delete(c.id)
})
