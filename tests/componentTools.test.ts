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
import { takeComponentIssues } from '../server/actions.ts'

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
    expect(store.getFrame(a)!.approval?.status).toBe('needs_review')

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
    const card = (title: string) =>
      `<article class="card"><h3 class="title">${title}</h3><p class="body">Copy for ${title}</p></article>`
    const a = await framed(canvas.id, `${card('One')}${card('Two')}`, 'A')
    const b = await framed(canvas.id, card('Three'), 'B')

    const found = await call('find_component_candidates', { canvas_id: canvas.id })
    const top = found.data.candidates[0]
    expect(top.occurrences).toBe(3)
    expect(top.frames).toBe(2)
    expect(top.suggested_name).toBe('Card')
    /* the block is the finding, not each thing inside it */
    expect(found.data.candidates).toHaveLength(1)

    const made = await call('create_component', {
      canvas_id: canvas.id,
      name: top.suggested_name,
      frame_id: top.example.frame_id,
      element: top.example.element,
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
    expect((await call('find_component_candidates', { canvas_id: canvas.id })).data.candidates).toEqual([])
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
    const result = await call('delete_component', { canvas_id: canvas.id, component: 'Button' })
    expect(result.data.instances_detached).toBe(1)
    const html = store.getFrame(frameId)!.html
    expect(html).toContain('Stays')
    expect(html).not.toContain('data-doop-instance')
    expect(store.getComponents(canvas.id)).toEqual([])
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
