import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
}))

import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import * as propagation from '../server/propagation.ts'
import { takeComponentIssues } from '../server/actions.ts'
import { findComponent } from '../server/componentActions.ts'
import { previewDocument } from '../server/componentPreview.ts'
import { activeComponents } from '../shared/components.ts'

const OWNER = 'owner-1'
const AGENT = { agent_name: 'Tester' }

const CSS = `.btn { padding: 8px 14px; background: #111; color: #fff } .btn[data-tone="ghost"] { background: none; color: #111 }`
const BUTTON = `<button class="btn"><span class="label">Start</span></button>`

let client: Client

type ToolResponse = { content: { type: string; text?: string }[]; isError?: boolean }

/* tool results are whatever JSON each tool returns; the assertions are the type check */
async function call(
  name: string,
  args: Record<string, unknown>,
  // eslint-disable-next-line typescript/no-explicit-any
): Promise<{ data: any; text: string; isError: boolean }> {
  const response = (await client.callTool({ name, arguments: { ...AGENT, ...args } })) as ToolResponse
  /* instances follow a changed main in the background: tests read the settled canvas */
  await propagation.whenIdle()
  const texts = response.content.flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
  let data: unknown
  try {
    data = JSON.parse(texts[0] ?? '')
  } catch {
    data = undefined
  }
  return { data, text: texts.join('\n'), isError: !!response.isError }
}

function newCanvas(name = 'Canvas') {
  return store.createCanvas(name, OWNER)
}

async function button(canvasId: string) {
  const { data } = await call('create_component', {
    canvas_id: canvasId,
    name: 'Button',
    description: 'The action button',
    html: BUTTON,
    css: CSS,
    props: [{ name: 'tone', type: 'enum', options: ['solid', 'ghost'] }],
  })
  return data
}

async function framed(canvasId: string, body: string, name = 'Screen') {
  const { data } = await call('create_frame', {
    canvas_id: canvasId,
    name,
    html: `<!doctype html><html><head></head><body>${body}</body></html>`,
  })
  return data.frame.id as string
}

beforeEach(async () => {
  for (const c of store.allCanvases()) store.canvases.delete(c.id)
  const server = buildMcpServer('Owner', OWNER)
  client = new Client({ name: 'components-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
})

afterEach(async () => {
  await client.close()
})

describe('an agent working with components', () => {
  it('creates one from markup, on its own page, with props it did not have to spell out', async () => {
    const canvas = newCanvas()
    const created = await button(canvas.id)
    expect(created.ok).toBe(true)
    expect(created.component.signature).toBe('Button(tone: solid|ghost = solid, label: text)')
    expect(created.component.usage).toContain('<doop-use component="Button"')
    const main = store.getFrame(created.main_frame_id)!
    expect(store.getCanvas(canvas.id)!.pages?.find((page) => page.id === main.pageId)?.name).toBe('Components')
    const listed = await call('get_canvas', { canvas_id: canvas.id })
    expect(listed.data.components[0].name).toBe('Button')
    expect(listed.data.note).toContain('doop-use')
  })

  it('previews every variant for an agent, and only the default for the panel', async () => {
    const canvas = newCanvas()
    const { data: created } = await call('create_component', {
      canvas_id: canvas.id,
      name: 'Button',
      html: BUTTON,
      css: CSS,
      props: [{ name: 'tone', type: 'enum', options: ['solid', 'ghost'], default: 'ghost' }],
    })
    const def = findComponent(canvas.id, created.component.id)!
    const sheet = previewDocument(canvas.id, def)
    expect(sheet.variants).toBe(2)
    expect(sheet.html).toContain('tone=solid')
    const card = previewDocument(canvas.id, def, 'default')
    expect(card.variants).toBe(1)
    expect(card.html).not.toContain('<figcaption>')
    expect(card.html).toContain('data-tone="ghost"')
    expect(card.html).not.toContain('data-tone="solid"')
  })

  it('reads a screen back in short form, at a fraction of the size, and can edit it', async () => {
    const canvas = newCanvas()
    await button(canvas.id)
    const uses = Array.from({ length: 20 }, (_, i) => `<doop-use component="Button" label="Action ${i}"></doop-use>`)
    const frameId = await framed(canvas.id, uses.join(''))
    const full = store.getFrame(frameId)!.html
    const read = await call('get_frame', { frame_id: frameId })
    expect(read.data.html.length).toBeLessThan(full.length / 3)
    expect(read.data.instances).toHaveLength(20)
    expect(read.data.instances[3].props).toEqual({ label: 'Action 3' })
    expect((await call('get_frame', { frame_id: frameId, expand_components: true })).data.html).toBe(full)

    const edit = await call('edit_frame_html', {
      frame_id: frameId,
      old_str: 'label="Action 3"',
      new_str: 'label="Renamed" tone="ghost"',
    })
    expect(edit.isError).toBe(false)
    const html = store.getFrame(frameId)!.html
    expect(html).toContain('Renamed')
    expect(html).toContain('data-tone="ghost"')
    expect(html.match(/ data-doop-instance=/g)).toHaveLength(20)
    /* the other nineteen did not change, down to their ids */
    expect(html).toContain(/data-doop-id="[a-z0-9]{6}"/.exec(full)![0])
  })

  it('hears about mistakes in the result, with what would have worked', async () => {
    const canvas = newCanvas()
    await button(canvas.id)
    const result = await call('create_frame', {
      canvas_id: canvas.id,
      name: 'Bad',
      html: '<doop-use component="Buton"></doop-use><doop-use component="Button" tone="neon" nope="1"></doop-use>',
    })
    expect(result.text).toContain('no component “Buton”')
    expect(result.text).toContain('solid | ghost')
    expect(result.text).toContain('no prop “nope”')
  })

  it('is told when it redrew a component by hand', async () => {
    const canvas = newCanvas()
    await button(canvas.id)
    const result = await call('create_frame', { canvas_id: canvas.id, name: 'Redrawn', html: `<div>${BUTTON}</div>` })
    expect(result.text).toContain('match')
    expect(result.text).toContain('“Button”')
    expect(result.text).toContain('<doop-use')
  })

  it('changes every instance with one call, and sees the impact first', async () => {
    const canvas = newCanvas()
    const created = await button(canvas.id)
    const a = await framed(canvas.id, '<doop-use component="Button" label="Keep A"></doop-use>', 'A')
    const b = await framed(
      canvas.id,
      '<doop-use component="Button" label="Keep B"></doop-use><doop-use component="Button"></doop-use>',
      'B',
    )
    store.updateFrame(
      a,
      {
        approval: {
          status: 'ready_for_dev',
          approvedBy: 'R',
          approvedByUserId: 'r',
          approvedAt: 1,
          approvedFrameUpdatedAt: 1,
        },
      },
      'R',
    )

    const dry = await call('update_component', {
      canvas_id: canvas.id,
      component: 'Button',
      find: 'class="btn"',
      replace: 'class="btn big"',
      dry_run: true,
    })
    expect(dry.data.dry_run).toBe(true)
    expect(dry.data.impact.instances).toBe(3)
    expect(dry.data.impact.approvals_affected).toBe(1)
    expect(store.getFrame(a)!.html).not.toContain('btn big')

    const applied = await call('update_component', {
      canvas_id: canvas.id,
      component: 'Button',
      find: 'class="btn"',
      replace: 'class="btn big"',
    })
    expect(applied.isError).toBe(false)
    expect(applied.data.rev).toBe(2)
    for (const id of [a, b, created.main_frame_id]) expect(store.getFrame(id)!.html).toContain('btn big')
    expect(store.getFrame(a)!.html).toContain('Keep A')
    expect(store.getFrame(b)!.html).toContain('Keep B')
    /* the frame follows the component and keeps its sign-off */
    expect(store.getFrame(a)!.approval?.status).toBe('ready_for_dev')

    const back = await call('restore_component_version', { canvas_id: canvas.id, component: 'Button', rev: 1 })
    expect(back.isError).toBe(false)
    expect(back.data.rev).toBe(3)
    expect(store.getFrame(a)!.html).not.toContain('btn big')
    expect(store.getFrame(a)!.html).toContain('Keep A')
  })

  it('keeps overrides attached when the main is rewritten wholesale, and reports any it could not', async () => {
    const canvas = newCanvas()
    await button(canvas.id)
    const frameId = await framed(canvas.id, '<doop-use component="Button" id="abc123"></doop-use>')
    const part =
      /class="label" data-doop-prop="label" data-doop-part="([a-z]+)"|data-doop-part="([a-z]+)"[^>]*class="label"/.exec(
        store.getComponents(canvas.id)[0]!.template,
      )
    const key = part?.[1] ?? part?.[2]
    expect(key).toBeTruthy()
    await call('update_instances', {
      canvas_id: canvas.id,
      frame_id: frameId,
      instances: [{ instance_id: 'abc123', overrides: { [key!]: { style: { color: 'red' } } } }],
    })
    expect(store.getFrame(frameId)!.html).toContain('color: red')
    /* a rewrite with no keys at all: same structure, new look */
    const rewrite = await call('update_component', {
      canvas_id: canvas.id,
      component: 'Button',
      html: '<button class="btn wide"><span class="label" data-doop-prop="label">Go</span></button>',
    })
    expect(rewrite.data.impact.overrides_orphaned).toEqual([])
    const html = store.getFrame(frameId)!.html
    expect(html).toContain('btn wide')
    expect(html).toContain('color: red')
  })

  it('turns repeated markup into linked instances, differences becoming props', async () => {
    const canvas = newCanvas()
    const card = (title: string, id = '') =>
      `<article class="card"${id ? ` data-doop-id="${id}"` : ''}><h3 class="title">${title}</h3><p class="body">Copy for ${title}</p></article>`
    /* an id an agent wrote itself, not one Doop stamped */
    const a = await framed(canvas.id, `${card('One', 'card-one')}${card('Two')}`, 'A')
    const b = await framed(canvas.id, card('Three'), 'B')

    const made = await call('create_component', {
      canvas_id: canvas.id,
      name: 'Card',
      frame_id: a,
      element: 'card-one',
      replace_matching: true,
    })
    expect(made.isError).toBe(false)
    expect(made.data.converted.reduce((n: number, c: { instances: number }) => n + c.instances, 0)).toBe(2)

    const first = store.getFrame(a)!.html
    const second = store.getFrame(b)!.html
    expect(first).toContain('Two')
    expect(second).toContain('Three')
    expect(second).toContain('data-doop-instance')
    expect(second).toMatch(/data-doop-props="[^"]*Three/)
    expect(second).not.toContain('data-doop-overrides')

    await call('update_component', {
      canvas_id: canvas.id,
      component: 'Card',
      find: 'class="card"',
      replace: 'class="card v2"',
    })
    expect(store.getFrame(a)!.html.match(/card v2/g)!.length).toBeGreaterThanOrEqual(2)
    expect(store.getFrame(b)!.html).toContain('card v2')
    expect(store.getFrame(b)!.html).toContain('Three')
  })

  it('places instances and changes several in one write', async () => {
    const canvas = newCanvas()
    await button(canvas.id)
    const frameId = await framed(canvas.id, '<main data-doop-id="mainid"><h1>Hi</h1></main>')
    const placed = await call('insert_instance', {
      canvas_id: canvas.id,
      frame_id: frameId,
      component: 'Button',
      target: 'mainid',
      props: { label: 'Placed' },
    })
    expect(placed.data.instance_id).toMatch(/^[a-z0-9]{6}$/)
    expect(store.getFrame(frameId)!.html).toMatch(/<\/h1><button/)
    const bad = await call('update_instances', {
      canvas_id: canvas.id,
      frame_id: frameId,
      instances: [{ instance_id: placed.data.instance_id, props: { tone: 'neon' } }],
    })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('solid | ghost')
    const changed = await call('update_instances', {
      canvas_id: canvas.id,
      frame_id: frameId,
      instances: [
        { instance_id: placed.data.instance_id, props: { tone: 'ghost' } },
        { instance_id: 'nosuch', reset: true },
      ],
    })
    expect(changed.data.not_found).toEqual(['nosuch'])
    expect(store.getFrame(frameId)!.html).toContain('data-tone="ghost"')
    const detached = await call('update_instances', {
      canvas_id: canvas.id,
      frame_id: frameId,
      instances: [{ instance_id: placed.data.instance_id, detach: true }],
    })
    expect(detached.isError).toBe(false)
    const html = store.getFrame(frameId)!.html
    expect(html).not.toContain('data-doop-instance')
    expect(html).toContain('Placed')
  })

  it('keeps what is built from a component working when it is renamed', async () => {
    const canvas = newCanvas()
    await button(canvas.id)
    await call('create_component', {
      canvas_id: canvas.id,
      name: 'Card',
      html: '<div class="card"><h2>Title</h2><doop-use component="Button" label="Inside"></doop-use><div data-doop-slot="extra"></div></div>',
    })
    const frameId = await framed(
      canvas.id,
      '<doop-use component="Card"><doop-use slot="extra" component="Button" label="Slotted"></doop-use></doop-use>',
    )
    await call('update_component', { canvas_id: canvas.id, component: 'Button', name: 'Action' })
    await call('update_component', {
      canvas_id: canvas.id,
      component: 'Card',
      find: 'class="card"',
      replace: 'class="card v2"',
    })
    const html = store.getFrame(frameId)!.html
    expect(html).toContain('card v2')
    expect(html).toContain('Inside')
    expect(html).toContain('Slotted')
    expect(takeComponentIssues(frameId)).toEqual([])
    expect((await call('get_frame', { frame_id: frameId })).data.instances[0].component).toBe('Card')
  })

  it('deletes a component without touching what anything looks like', async () => {
    const canvas = newCanvas()
    await button(canvas.id)
    const frameId = await framed(canvas.id, '<doop-use component="Button" label="Stays"></doop-use>')
    const before = store.getFrame(frameId)!.html
    const result = await call('delete_component', { canvas_id: canvas.id, component: 'Button' })
    expect(result.data.instances_kept).toBe(1)
    /* a soft delete: no frame is written, the instance is as it was, the definition is kept */
    expect(store.getFrame(frameId)!.html).toBe(before)
    expect(store.getComponents(canvas.id).map((def) => def.status)).toEqual(['deleted'])
    expect((await call('list_components', { canvas_id: canvas.id })).data.components).toEqual([])

    /* cutting the instances loose is asked for, and happens in the background */
    const detached = await call('delete_component', {
      canvas_id: canvas.id,
      component: 'Button',
      detach_instances: true,
    })
    expect(detached.data.detach).toMatchObject({ queued: true, instances: 1 })
    const html = store.getFrame(frameId)!.html
    expect(html).toContain('Stays')
    expect(html).not.toContain('data-doop-instance')
  })

  it('imports from a library and pulls updates only on request', async () => {
    const library = newCanvas('Library')
    await button(library.id)
    const canvas = newCanvas('Product')
    const listed = await call('list_components', { canvas_id: canvas.id, libraries: true })
    expect(listed.data.libraries[0].canvas_name).toBe('Library')
    const imported = await call('import_component', {
      canvas_id: canvas.id,
      source_canvas_id: library.id,
      component: 'Button',
    })
    expect(imported.isError).toBe(false)
    const frameId = await framed(canvas.id, '<doop-use component="Button" label="Mine" tone="ghost"></doop-use>')

    await call('update_component', {
      canvas_id: library.id,
      component: 'Button',
      find: 'class="btn"',
      replace: 'class="btn lib2"',
    })
    expect(store.getFrame(frameId)!.html).not.toContain('lib2')
    const after = await call('list_components', { canvas_id: canvas.id })
    expect(after.data.components[0].library_update_available.to_rev).toBe(2)

    const synced = await call('sync_component', { canvas_id: canvas.id, component: 'Button' })
    expect(synced.data.updated).toBe(true)
    const html = store.getFrame(frameId)!.html
    expect(html).toContain('lib2')
    expect(html).toContain('Mine')
    expect(html).toContain('data-tone="ghost"')
    expect(
      (await call('list_components', { canvas_id: canvas.id })).data.components[0].library_update_available,
    ).toBeUndefined()
  })

  it('is told that template attributes on a <doop-use> do nothing, and no override is stored for them', async () => {
    const canvas = newCanvas()
    await button(canvas.id)
    const made = await call('create_component', {
      canvas_id: canvas.id,
      name: 'Card',
      html: '<div class="card"><h3 data-doop-prop="title">Pro</h3><doop-use component="Button" data-doop-prop="label:cta" data-doop-if="show-cta"></doop-use></div>',
    })
    expect(made.isError).toBe(false)
    expect(made.text).toContain('COMPONENT: data-doop-prop on <doop-use component="Button">')
    expect(made.text).toContain('data-doop-slot')
    expect(made.text).toContain('COMPONENT: data-doop-if on <doop-use component="Button">')
    const card = findComponent(canvas.id, 'Card')!
    expect(card.props.map((prop) => prop.name)).toEqual(['title'])
    expect(card.template).not.toContain('overrides=')
    expect(card.template).not.toContain('label:cta')
    expect(store.getFrame(made.data.main_frame_id)!.html).not.toContain('label:cta')
    expect(store.getFrame(made.data.main_frame_id)!.html).not.toContain('show-cta')

    /* a binding that binds nothing does not stand in for the component's own props */
    const tier = await call('create_component', {
      canvas_id: canvas.id,
      name: 'Tier',
      html: '<div class="tier"><h3>Pro</h3><doop-use component="Button" data-doop-prop="label:cta">Buy</doop-use></div>',
    })
    expect(tier.data.inferred_props).toEqual(['title'])
    expect(tier.text.match(/COMPONENT: data-doop-prop/g)).toHaveLength(1)
    expect(findComponent(canvas.id, 'Tier')!.template).not.toContain('overrides=')

    /* the same in a frame, where it is not nested in anything */
    const placed = await call('create_frame', {
      canvas_id: canvas.id,
      name: 'Screen',
      html: '<doop-use component="Button" data-doop-prop="label" data-doop-on="click"></doop-use>',
    })
    expect(placed.text).toContain('COMPONENT: data-doop-prop on <doop-use component="Button">')
    const html = store.getFrame(placed.data.frame.id)!.html
    expect(html).not.toContain('data-doop-prop')
    /* prototype wiring on an instance is the instance's own, and stays */
    expect(html).toContain('data-doop-on="click"')
  })

  it('keeps css that restyles a nested component from this one, and names the rules it did not keep', async () => {
    const canvas = newCanvas()
    await button(canvas.id)
    const made = await call('create_component', {
      canvas_id: canvas.id,
      name: 'Plan',
      html: '<div class="plan"><h3 class="name">Pro</h3><doop-use component="Button"></doop-use></div>',
      css: '.plan { padding: 8px } .plan .btn { width: 100% } .plan > .btn .label { color: red } .btn .label { color: blue } .nope { color: green }',
    })
    expect(made.isError).toBe(false)
    const plan = () => findComponent(canvas.id, 'Plan')!
    expect(plan().rawCss).toContain('.plan .btn { width: 100% }')
    expect(plan().rawCss).toContain('.plan > .btn .label { color: red }')
    /* scoped to this component's instances, so it reaches the Button inside a Plan and no other */
    expect(plan().css).toContain(`.plan:where([data-doop-instance="${plan().id}"]) .btn { width: 100% }`)
    expect(plan().rawCss).not.toContain('color: blue')
    expect(plan().rawCss).not.toContain('.nope')
    expect(made.text).toContain('COMPONENT: these CSS rules name nothing in “Plan”')
    expect(made.text).toContain('.btn .label, .nope')
    expect(made.text).not.toContain('.plan .btn,')

    const frameId = await framed(
      canvas.id,
      '<doop-use component="Plan"></doop-use><doop-use component="Button"></doop-use>',
    )
    expect(store.getFrame(frameId)!.html).toContain(`.plan:where([data-doop-instance="${plan().id}"]) .btn`)

    const updated = await call('update_component', {
      canvas_id: canvas.id,
      component: 'Plan',
      css: '.plan .btn { width: auto } .label { font-weight: 600 }',
    })
    expect(updated.isError).toBe(false)
    expect(plan().rawCss).toContain('.plan .btn { width: auto }')
    expect(updated.text).toContain('were not kept: .label.')
    expect(store.getFrame(frameId)!.html).toContain('width: auto')

    const clean = await call('update_component', {
      canvas_id: canvas.id,
      component: 'Plan',
      css: '.plan .btn { width: 50% }',
    })
    expect(clean.text).not.toContain('were not kept')
  })

  it('names inferred props after what each element is, and lists them in the result', async () => {
    const canvas = newCanvas()
    const made = await call('create_component', {
      canvas_id: canvas.id,
      name: 'Offer',
      html: '<article style="padding: 16px"><img src="/a/x.png" alt=""><h3 style="margin: 0">Pro</h3><p class="text-sm mt-2">For teams</p><p>Billed yearly</p><a href="/buy" style="color: blue"><span>Buy</span></a></article>',
    })
    expect(made.isError).toBe(false)
    expect(made.data.component.signature).toBe(
      'Offer(image: image, title: text, text: text, text-2: text, link: link, label: text)',
    )
    expect(made.data.inferred_props).toEqual(['image', 'title', 'text', 'text-2', 'link', 'label'])
    expect(made.text).toContain('Props inferred from the markup: image, title, text, text-2, link, label')
    expect(made.text).toContain('data-doop-prop')

    /* names an author wrote are never touched, and nothing is listed as inferred */
    const own = await call('create_component', {
      canvas_id: canvas.id,
      name: 'Named',
      html: '<div><h3 data-doop-prop="headline">Pro</h3><p>Fixed copy</p></div>',
    })
    expect(own.data.component.signature).toBe('Named(headline: text)')
    expect(own.data.inferred_props).toBeUndefined()
    expect(own.text).not.toContain('Props inferred')
  })

  it('says where a component made from markup went, and how to use it', async () => {
    const canvas = newCanvas()
    const created = await call('create_component', { canvas_id: canvas.id, name: 'Button', html: BUTTON, css: CSS })
    expect(created.text).toContain('Components page')
    expect(created.text).toContain('No instance was placed')
    expect(created.text).toContain('<doop-use component="Button"')
    expect(created.text).toContain('insert_instance')
    const { tools } = await client.listTools()
    const description = tools.find((tool) => tool.name === 'create_component')!.description!
    const opening = description.split('. ').slice(0, 2).join('. ')
    expect(opening).toContain('Components page')
    expect(opening).toContain('<doop-use')
    expect(opening).toContain('insert_instance')
  })

  it('counts one update as one revision, whatever it changes together', async () => {
    const canvas = newCanvas()
    await button(canvas.id)
    const frameId = await framed(canvas.id, '<doop-use component="Button"></doop-use>')
    const before = findComponent(canvas.id, 'Button')!
    expect(before.rev).toBe(1)

    const both = await call('update_component', {
      canvas_id: canvas.id,
      component: 'Button',
      html: '<button class="btn wide"><span class="label" data-doop-prop="label">Start</span></button>',
      props: [{ name: 'tone', type: 'enum', options: ['ghost', 'solid'] }],
    })
    expect(both.data.rev).toBe(2)
    const after = findComponent(canvas.id, 'Button')!
    expect(after.history.map((entry) => entry.rev)).toEqual([1])
    /* the kept revision is what instances were rendered from: the old markup with the old props */
    expect(after.history[0]!.template).toBe(before.template)
    expect(after.history[0]!.props).toEqual(before.props)
    const html = store.getFrame(frameId)!.html
    expect(html).toContain('btn wide')
    expect(html).toContain('data-doop-rev="2"')
    /* an instance that set nothing follows the new default */
    expect(html).toContain('data-tone="ghost"')

    const propsOnly = await call('update_component', {
      canvas_id: canvas.id,
      component: 'Button',
      props: [{ name: 'tone', type: 'enum', options: ['solid', 'ghost', 'outline'] }],
    })
    expect(propsOnly.data.rev).toBe(3)
    expect(store.getFrame(frameId)!.html).toContain('data-tone="solid"')

    const back = await call('restore_component_version', { canvas_id: canvas.id, component: 'Button', rev: 1 })
    expect(back.data.rev).toBe(4)
    expect(findComponent(canvas.id, 'Button')!.history.map((entry) => entry.rev)).toEqual([1, 2, 3])
    expect(store.getFrame(frameId)!.html).not.toContain('btn wide')
  })

  it('cannot reach a canvas it cannot read', async () => {
    const other = store.createCanvas('Private', 'somebody-else')
    const canvas = newCanvas()
    expect((await call('list_components', { canvas_id: other.id })).isError).toBe(true)
    const imported = await call('import_component', {
      canvas_id: canvas.id,
      source_canvas_id: other.id,
      component: 'Button',
    })
    expect(imported.isError).toBe(true)
    expect(imported.text).toContain('cannot read')
  })
})

describe('setting up a component system in one call', () => {
  const kit = (canvasId: string, components: Record<string, unknown>[]) =>
    call('create_components', { canvas_id: canvasId, components })

  it('makes a kit in order, so a pattern can nest the primitive listed before it', async () => {
    const canvas = newCanvas()
    const made = await kit(canvas.id, [
      { name: 'Button', html: BUTTON, css: CSS, props: [{ name: 'tone', type: 'enum', options: ['solid', 'ghost'] }] },
      { name: 'Badge', html: '<span class="badge">New</span>', css: '.badge { padding: 2px 6px }' },
      {
        name: 'Card',
        html: '<div class="card"><h3>Title</h3><doop-use component="Badge"></doop-use><doop-use component="Button" tone="ghost"></doop-use></div>',
        css: '.card { padding: 16px }',
      },
    ])
    expect(made.isError).toBe(false)
    expect(made.data).toMatchObject({ ok: true, created: 3, failed: 0 })
    expect(made.data.results.map((result: { component: { name: string } }) => result.component.name)).toEqual([
      'Button',
      'Badge',
      'Card',
    ])
    expect(made.text).toContain('<doop-use component="Card"')
    const canvasNow = store.getCanvas(canvas.id)!
    const mains = made.data.results.map((result: { main_frame_id: string }) => store.getFrame(result.main_frame_id)!)
    const page = canvasNow.pages?.find((candidate) => candidate.name === 'Components')
    expect(mains.every((main: { pageId?: string }) => main.pageId === page?.id)).toBe(true)
    /* the card's main renders the nested ones as linked instances */
    const card = mains[2]
    for (const nested of ['Badge', 'Button'])
      expect(card.html).toMatch(new RegExp(`<[a-z]+[^>]*data-doop-instance="${findComponent(canvas.id, nested)!.id}"`))
    /* and the mains do not sit on top of each other */
    const boxes = mains.map((main: { x: number; y: number }) => `${main.x},${main.y}`)
    expect(new Set(boxes).size).toBe(3)
  })

  it('reports a refused entry and still makes the others', async () => {
    const canvas = newCanvas()
    await button(canvas.id)
    const made = await kit(canvas.id, [
      { name: 'Button', html: BUTTON, css: CSS },
      { name: 'Badge', html: '<span class="badge">New</span>' },
    ])
    expect(made.isError).toBe(false)
    expect(made.data).toMatchObject({ ok: false, created: 1, failed: 1 })
    expect(made.data.results[0]).toMatchObject({ index: 0, ok: false, name: 'Button' })
    expect(made.data.results[0].error).toBeTruthy()
    expect(made.data.results[1]).toMatchObject({ index: 1, ok: true })
    expect(made.text).toContain('1 entry was refused')
    const names = activeComponents(store.getCanvas(canvas.id)!.components).map((def) => def.name)
    expect(names.sort()).toEqual(['Badge', 'Button'])
  })

  it('refuses an entry that nests a refused one, rather than saving it without that part', async () => {
    const canvas = newCanvas()
    const made = await kit(canvas.id, [
      /* an enum with no options is refused */
      { name: 'Button', html: BUTTON, css: CSS, props: [{ name: 'tone', type: 'enum' }] },
      { name: 'Card', html: '<div class="card"><h3>Title</h3><doop-use component="Button"></doop-use></div>' },
      { name: 'Badge', html: '<span class="badge">New</span>' },
    ])
    expect(made.data).toMatchObject({ ok: false, created: 1, failed: 2 })
    expect(made.data.results[1]).toMatchObject({ ok: false, name: 'Card' })
    expect(made.data.results[1].error).toContain('it nests “Button”')
    expect(made.data.results[2]).toMatchObject({ ok: true })
    expect(activeComponents(store.getCanvas(canvas.id)!.components).map((def) => def.name)).toEqual(['Badge'])
    /* nothing of the refused card is left on the Components page */
    expect(store.getCanvas(canvas.id)!.frames.map((frame) => frame.name)).toEqual(['Badge'])
    /* sent again in order once fixed, both are made, the card holding its button */
    const again = await kit(canvas.id, [
      { name: 'Button', html: BUTTON, css: CSS },
      { name: 'Card', html: '<div class="card"><h3>Title</h3><doop-use component="Button"></doop-use></div>' },
    ])
    expect(again.data).toMatchObject({ ok: true, created: 2 })
    const card = store.getFrame(again.data.results[1].main_frame_id)!
    expect(card.html).toContain(`data-doop-instance="${findComponent(canvas.id, 'Button')!.id}"`)
  })

  it('takes at most twelve at a time', async () => {
    const canvas = newCanvas()
    const many = Array.from({ length: 13 }, (_, index) => ({ name: `Part${index}`, html: `<i>${index}</i>` }))
    const refused = await kit(canvas.id, many)
    expect(refused.isError).toBe(true)
    expect(activeComponents(store.getCanvas(canvas.id)!.components)).toEqual([])
  })
})
