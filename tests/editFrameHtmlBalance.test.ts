import { describe, expect, it, vi } from 'vitest'
import type { Actor } from '../shared/types'

const versions = vi.hoisted(() => [] as { html: string }[])
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
  refreshAssetRefs: () => {},
  saveFrame: () => {},
  saveToken: () => {},
  deleteToken: () => {},
  saveComponent: () => {},
  saveCanvasCopy: async () => {},
  frameWritePending: () => false,
  saveFrameVersion: (version: { html: string }) => void versions.push(version),
}))
vi.mock('../server/fonts.ts', () => ({ fontsForCanvas: () => [] }))
const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { runComponentTool } = await import('../server/componentTools.ts')
const { runCanvasWrite, wireCanvasWrites } = await import('../server/canvasWrites.ts')
const { compactFrameHtml, unbalancedProblem } = await import('../server/componentActions.ts')
const { tagBalance } = await import('../server/componentEngine.ts')
const { runOperation } = await import('../server/workBudget.ts')

/**
 * edit_frame_html is a plain find-and-replace. A replacement that opened a <doop-use> or a
 * <template slot> without closing it was accepted: the whole-write pass read the <doop-use> as
 * empty, the stray <template> swallowed the rest of the document as inert content, and the
 * instances after it read back written out, so the agent's next edit failed as ambiguous. Such
 * an edit is refused now, with nothing written, on MCP and the resident alike.
 */

wireCanvasWrites()

const agent: Actor = { name: 'Claude', kind: 'agent', color: '#e5533c' }
const page = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`

async function canvasWith(components: Record<string, string>) {
  const canvasId = store.createCanvas('balance', 'kevin').id
  for (const [name, html] of Object.entries(components)) {
    const outcome = await runComponentTool(
      'create_component',
      { name, html, css: '', auto_props: false },
      {
        canvas: store.getCanvas(canvasId)!,
        actor: agent,
        canRead: () => true,
        canEdit: () => true,
        userId: undefined,
        readableCanvases: () => [],
      },
    )
    if (!outcome.ok) throw new Error(outcome.error)
  }
  return canvasId
}

const COMPONENTS = {
  Panel: '<section class="panel"><div data-doop-slot="content"><p>Default panel</p></div></section>',
  Badge: '<span class="badge" data-doop-prop="label">New</span>',
}
const BODY =
  '<main><h1>Title</h1><p id="target">replace me</p><doop-use component="Badge" label="One"></doop-use><doop-use component="Badge" label="Two"></doop-use><footer>end</footer></main>'

async function screen() {
  const canvasId = await canvasWith(COMPONENTS)
  const frame = actions.createFrame(canvasId, { name: 'Screen', html: page(BODY) }, agent)!
  return { canvasId, frameId: frame.id }
}

const edit = (canvasId: string, frameId: string, find: string, replace: string) =>
  runOperation('test', canvasId, () =>
    runCanvasWrite(canvasId, { type: 'edit-frame-html', frameId, find, replace, actor: agent, inline: 'mcp' }),
  )

const nets = (html: string) => {
  const balance = tagBalance(html)
  return { 'doop-use': balance['doop-use'].net, template: balance.template.net }
}

describe('tagBalance', () => {
  it('counts the <doop-use> and <template> tags a piece of HTML leaves open', () => {
    expect(nets('<doop-use component="Panel"><template slot="content">')).toEqual({ 'doop-use': 1, template: 1 })
    expect(nets('</template></doop-use>')).toEqual({ 'doop-use': -1, template: -1 })
    expect(nets('<doop-use component="A"><TEMPLATE slot="x"></template ></doop-use>')).toEqual({
      'doop-use': 0,
      template: 0,
    })
  })

  it('says how far a piece closes past what it opened', () => {
    expect(tagBalance('</doop-use><doop-use component="A">')['doop-use']).toEqual({ net: 0, low: -1 })
    expect(tagBalance('<doop-use component="A"></doop-use>')['doop-use']).toEqual({ net: 0, low: 0 })
  })

  it('takes a self-closing <doop-use> as complete', () => {
    expect(nets('<doop-use component="Badge" label="x" />')).toEqual({ 'doop-use': 0, template: 0 })
  })

  it('ignores tags written in attribute values, scripts and comments', () => {
    const overrides = `<div data-doop-overrides='{"html":"<doop-use component=\\"Badge\\"><template slot=\\"a\\">"}'>x</div>`
    expect(nets(overrides)).toEqual({ 'doop-use': 0, template: 0 })
    expect(nets('<script>const t = "<template>"</script><!-- <doop-use component="A"> -->')).toEqual({
      'doop-use': 0,
      template: 0,
    })
  })
})

describe('edit_frame_html keeps <doop-use> and <template> balanced', () => {
  it('refuses a replacement that opens an instance and its slot without closing them', async () => {
    const { canvasId, frameId } = await screen()
    const before = compactFrameHtml(store.getFrame(frameId)!)
    const answer = await edit(
      canvasId,
      frameId,
      '<p id="target">replace me</p>',
      '<doop-use component="Panel"><template slot="content">',
    )
    expect(answer.ok).toBe(false)
    if (answer.ok || !('unbalanced' in answer)) throw new Error('expected an unbalanced refusal')
    const message = unbalancedProblem(answer.unbalanced, 'old_str', 'new_str')
    expect(message).toContain('new_str opens 1 more <doop-use> than it closes (old_str: balanced)')
    expect(message).toContain('1 more <template>')
    expect(message).toContain('Nothing was written.')
    expect(compactFrameHtml(store.getFrame(frameId)!)).toBe(before)
  })

  it('refuses a replacement that drops a closing tag', async () => {
    const { canvasId, frameId } = await screen()
    const answer = await edit(
      canvasId,
      frameId,
      '<doop-use component="Badge" label="One"></doop-use>',
      '<doop-use component="Badge" label="Uno">',
    )
    expect(!answer.ok && 'unbalanced' in answer).toBe(true)
  })

  it('takes a balanced edit that adds a whole instance with slot content', async () => {
    const { canvasId, frameId } = await screen()
    const answer = await edit(
      canvasId,
      frameId,
      '<p id="target">replace me</p>',
      '<doop-use component="Panel"><template slot="content"><p>Mine</p></template></doop-use>',
    )
    expect(answer.ok).toBe(true)
    const after = compactFrameHtml(store.getFrame(frameId)!)
    expect(after).toContain('<p>Mine</p>')
    /* the instances after it stay instances, so the next edit finds one of them once */
    expect(after.split('<doop-use component="Badge"').length - 1).toBe(2)
    const next = await edit(canvasId, frameId, '<footer>end</footer>', '<footer>fin</footer>')
    expect(next.ok).toBe(true)
  })

  it('refuses an edit whose tags pair up wrongly around it, though it opens as many as it closes', async () => {
    const { canvasId, frameId } = await screen()
    const before = store.getFrame(frameId)!.html
    /* the instances after it would nest inside the new one, and it would be left unclosed */
    const answer = await edit(
      canvasId,
      frameId,
      '<p id="target">replace me</p>',
      '</doop-use><doop-use component="Panel">',
    )
    expect(answer.ok).toBe(false)
    if (answer.ok || !('unbalanced' in answer)) throw new Error('expected an unbalanced refusal')
    expect(unbalancedProblem(answer.unbalanced, 'old_str', 'new_str')).toContain(
      'new_str closes a <doop-use> before opening one where old_str does not',
    )
    expect(store.getFrame(frameId)!.html).toBe(before)
  })

  it('takes an edit whose find text and replacement close and reopen alike', async () => {
    const { canvasId, frameId } = await screen()
    const answer = await edit(
      canvasId,
      frameId,
      'label="One"></doop-use><doop-use component="Badge"',
      'label="Uno"></doop-use><doop-use component="Badge"',
    )
    expect(answer.ok).toBe(true)
    expect(compactFrameHtml(store.getFrame(frameId)!)).toContain('label="Uno"')
  })
})

describe('the resident wording', () => {
  it('names the resident tool’s parameters', () => {
    const message = unbalancedProblem(
      { tags: [{ tag: 'template', find: { net: 0, low: 0 }, replace: { net: 1, low: 0 } }] },
      '"find"',
      '"replace"',
    )
    expect(message).toMatch(/^"replace" opens 1 more <template> than it closes \("find": balanced\)/)
  })
})
