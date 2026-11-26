import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { parse } from 'parse5'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  refreshAssetRefs: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
}))

import { buildMcpServer } from '../server/mcp.ts'
import { execTool, newRunState, RESIDENT_TOOLS } from '../server/resident.ts'
import * as screenshot from '../server/screenshot.ts'
import { DEFAULT_ROLE_ID, roleName } from '../shared/agents.ts'
import { store } from '../server/store.ts'
import { renderedHtml } from './rendered.ts'
import * as propagation from '../server/propagation.ts'
import { resolveActor, takeComponentIssues } from '../server/actions.ts'
import { findComponent } from '../server/componentActions.ts'
import { previewCombinations, previewDocument } from '../server/componentPreview.ts'
import { activeComponents } from '../shared/components.ts'
import { splitTopLevel } from '../server/componentCss.ts'
import { resolveElement } from '../server/elementIds.ts'
import { elementIs } from '../server/parse5Select.ts'

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
  vi.restoreAllMocks()
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

  it('renders defaults, a single selection, or just the requested comparisons', async () => {
    const canvas = newCanvas()
    const { data: created } = await call('create_component', {
      canvas_id: canvas.id,
      name: 'Button',
      html: BUTTON,
      css: CSS,
      props: [
        { name: 'tone', type: 'enum', options: ['solid', 'ghost'], default: 'ghost' },
        { name: 'size', type: 'enum', options: ['sm', 'lg'], default: 'sm' },
      ],
    })
    const def = findComponent(canvas.id, created.component.id)!
    const render = (props?: Record<string, string | string[]>) =>
      previewDocument(canvas.id, def, previewCombinations(def, props))
    const card = render()
    expect(card.variants).toBe(1)
    expect(card.html).not.toContain('<figcaption>')
    expect(card.html).toContain('data-tone="ghost"')

    const exact = render({ size: 'lg' })
    expect(exact.variants).toBe(1)
    expect(exact.html).toContain('data-size="lg"')
    expect(exact.html).toContain('data-tone="ghost"')

    const comparison = render({ tone: ['ghost', 'solid', 'ghost'] })
    expect(comparison.variants).toBe(2)
    expect(comparison.html).toContain('tone=solid</figcaption>')
    expect(comparison.html).toContain('tone=ghost</figcaption>')
    expect(comparison.html.match(/data-size="sm"/g)).toHaveLength(2)

    expect(() => render({ tone: ['solid', 'neon'] })).toThrow('its values: solid, ghost')
    const capture = vi.spyOn(screenshot, 'renderFrame').mockResolvedValue(Buffer.from('image'))
    const preview = await call('get_component_preview', {
      canvas_id: canvas.id,
      component: 'Button',
      props: { tone: ['ghost', 'solid'] },
    })
    expect(preview.isError).toBe(false)
    expect(capture.mock.calls[0]?.[0].html.match(/<figcaption>[^<]+/g)).toEqual([
      '<figcaption>tone=ghost',
      '<figcaption>tone=solid',
    ])
    const unknown = await call('get_component_preview', {
      canvas_id: canvas.id,
      component: 'Button',
      props: { colour: 'red' },
    })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain('its props: tone, size')
  })

  it('validates the resident selection even when the model cannot view images', async () => {
    const canvas = newCanvas()
    await button(canvas.id)
    const resident = resolveActor({ name: roleName(DEFAULT_ROLE_ID), kind: 'agent' })
    const runState = newRunState()
    const shoot = (input: Record<string, unknown>) =>
      execTool(
        { type: 'tool_use', id: 't1', name: 'screenshot_component', input: { component: 'Button', ...input } },
        canvas.id,
        resident,
        runState,
      )

    const capture = vi.spyOn(screenshot, 'renderFrame').mockResolvedValue(Buffer.from('image'))
    const comparison = await shoot({ props: { tone: ['ghost', 'solid'] } })
    expect(comparison.is_error).toBeUndefined()
    expect(String(comparison.content)).toContain('cannot view images')
    const wrong = await shoot({ props: { tone: 'outline' } })
    expect(wrong.is_error).toBe(true)
    expect(String(wrong.content)).toContain('its values: solid, ghost')
    expect((await shoot({ props: { tone: [] } })).is_error).toBe(true)
    const huge = await shoot({ props: { tone: ['solid', 'ghost'], label: ['1', '2', '3', '4', '5', '6', '7'] } })
    expect(huge.is_error).toBe(true)
    expect(String(huge.content)).toContain('Narrow the prop values')
    expect(capture).not.toHaveBeenCalled()

    runState.vision = true
    const image = await shoot({ props: { tone: 'ghost' } })
    expect(image.content).toMatchObject([{ type: 'image' }])
    expect(capture.mock.calls[0]?.[0].html).toContain('tone=ghost</figcaption>')
  })

  it('reads a screen back in short form, at a fraction of the size, and can edit it', async () => {
    const canvas = newCanvas()
    await button(canvas.id)
    const uses = Array.from({ length: 20 }, (_, i) => `<doop-use component="Button" label="Action ${i}"></doop-use>`)
    const frameId = await framed(canvas.id, uses.join(''))
    /* the full form is the frame as rendered: its source with the canvas's styles composed in */
    const full = renderedHtml(frameId)
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

  it('edits text copied from the full form, also where it runs into what Doop supplied', async () => {
    const canvas = newCanvas()
    await button(canvas.id)
    const frameId = await framed(canvas.id, '<h1>Old title</h1><doop-use component="Button" label="Go"></doop-use>')
    const full = (await call('get_frame', { frame_id: frameId, expand_components: true })).data.html as string
    /* the end of the Button's stylesheet, the head's close and the heading: one stretch of the full form */
    const spanning = /\n<\/style>\n<\/head><body><h1>Old title<\/h1>/.exec(full)?.[0]
    expect(spanning).toBeDefined()
    expect(store.getFrame(frameId)!.html).not.toContain(spanning)
    const edit = await call('edit_frame_html', {
      frame_id: frameId,
      old_str: spanning,
      new_str: spanning!.replace('Old title', 'New title'),
    })
    expect(edit.isError).toBe(false)
    const stored = store.getFrame(frameId)!.html
    expect(stored).toContain('<h1>New title</h1>')
    /* stored as the frame's source, and rendered as before with the new heading */
    expect(stored).not.toContain('data-doop-component-css')
    expect(renderedHtml(frameId)).toBe(full.replace('Old title', 'New title'))

    /* an edit of nothing but the supplied stylesheet would be dropped on the way in: it says so */
    const rule = /padding: [^;}]+/.exec(full)![0]
    const lost = await call('edit_frame_html', { frame_id: frameId, old_str: rule, new_str: 'padding: 99px' })
    expect(lost.isError).toBe(true)
    expect(lost.text).toContain('update_component')
    expect(store.getFrame(frameId)!.html).toBe(stored)
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

  it('keeps overrides attached when the main is rewritten wholesale', async () => {
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
    await call('update_component', {
      canvas_id: canvas.id,
      component: 'Button',
      html: '<button class="btn wide"><span class="label" data-doop-prop="label">Go</span></button>',
    })
    const html = store.getFrame(frameId)!.html
    expect(html).toContain('btn wide')
    expect(html).toContain('color: red')
  })

  it('takes the markup as template, the name get_component returns it by, and refuses it twice', async () => {
    const canvas = newCanvas()
    await button(canvas.id)
    const read = await call('get_component', { canvas_id: canvas.id, component: 'Button' })
    const template = String(read.data.template).replace('class="btn"', 'class="btn wide"')
    const both = await call('update_component', { canvas_id: canvas.id, component: 'Button', html: template, template })
    expect(both.isError).toBe(true)
    expect(both.text).toContain('not both')
    const updated = await call('update_component', { canvas_id: canvas.id, component: 'Button', template })
    expect(updated.isError).toBe(false)
    expect(store.getComponents(canvas.id)[0]!.template).toContain('btn wide')
  })

  it('refuses a write over a name or description changed since it was read, which the revision does not show', async () => {
    const canvas = newCanvas()
    await button(canvas.id)
    const read = await call('get_component', { canvas_id: canvas.id, component: 'Button' })
    const pulled = { expected_rev: read.data.rev, expected_name: 'Button', expected_description: '' }
    await call('update_component', { canvas_id: canvas.id, component: 'Button', description: 'Theirs' })

    const stale = await call('update_component', {
      canvas_id: canvas.id,
      component: 'Button',
      description: 'Mine',
      ...pulled,
    })
    expect(stale.isError).toBe(true)
    expect(stale.text).toContain('someone changed it')
    expect(store.getComponents(canvas.id)[0]!.description).toBe('Theirs')

    await call('update_component', { canvas_id: canvas.id, component: 'Button', name: 'Action' })
    const renamed = await call('update_component', {
      canvas_id: canvas.id,
      component: 'Action',
      description: 'Mine',
      ...pulled,
      expected_description: 'Theirs',
    })
    expect(renamed.isError).toBe(true)
    expect(renamed.text).toContain('renamed from “Button”')

    const current = await call('update_component', {
      canvas_id: canvas.id,
      component: 'Action',
      description: 'Mine',
      ...pulled,
      expected_name: 'Action',
      expected_description: 'Theirs',
    })
    expect(current.isError).toBe(false)
    expect(store.getComponents(canvas.id)[0]!.description).toBe('Mine')
  })

  it('makes the picked element the main and leaves the other copies as they are', async () => {
    const canvas = newCanvas()
    const card = (title: string, id = '') =>
      `<article class="card"${id ? ` data-doop-id="${id}"` : ''}><h3 class="title">${title}</h3><p class="body">Copy for ${title}</p></article>`
    /* an id an agent wrote itself, not one Doop stamped */
    const a = await framed(canvas.id, `${card('One', 'card-one')}${card('Two')}`, 'A')
    const b = await framed(canvas.id, card('Three'), 'B')

    /* an agent holding an old tool schema may still send replace_matching: it does nothing */
    const made = await call('create_component', {
      canvas_id: canvas.id,
      name: 'Card',
      frame_id: a,
      element: 'card-one',
      replace_matching: true,
    })
    expect(made.isError).toBe(false)
    expect(made.data.converted).toBeUndefined()
    expect(made.data.matching_stopped).toBeUndefined()
    expect(store.getFrame(a)!.html.match(/data-doop-component=/g)).toHaveLength(1)
    expect(store.getFrame(a)!.html).not.toContain('data-doop-instance')
    expect(store.getFrame(b)!.html).not.toContain('data-doop-instance')
  })

  it('no longer offers replace_matching, to MCP clients or the resident agent', async () => {
    const { tools } = await client.listTools()
    const mcp = tools.find((tool) => tool.name === 'create_component')!
    expect(Object.keys(mcp.inputSchema.properties ?? {})).not.toContain('replace_matching')
    const resident = RESIDENT_TOOLS.find((tool) => tool.name === 'create_component')!
    expect(Object.keys(resident.input_schema.properties ?? {})).not.toContain('replace_matching')
    for (const description of [mcp.description, resident.description])
      expect(description).not.toContain('replace_matching')
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
    expect(renderedHtml(frameId)).toContain(`.plan:where([data-doop-instance="${plan().id}"]) .btn`)

    const updated = await call('update_component', {
      canvas_id: canvas.id,
      component: 'Plan',
      css: '.plan .btn { width: auto } .label { font-weight: 600 }',
    })
    expect(updated.isError).toBe(false)
    expect(plan().rawCss).toContain('.plan .btn { width: auto }')
    expect(updated.text).toContain('were not kept: .label.')
    expect(renderedHtml(frameId)).toContain('width: auto')

    const clean = await call('update_component', {
      canvas_id: canvas.id,
      component: 'Plan',
      css: '.plan .btn { width: 50% }',
    })
    expect(clean.text).not.toContain('were not kept')
  })

  /* #517: the CSS an agent writes for a component is the component's. Doop used to keep only the
     rules naming something in the main as it stands, so a state it is not in yet ([open], .is-on)
     or an element a script adds was dropped. A page's own stylesheet is still matched against the
     main when a component is made from an element on it. */
  it('keeps rules for states and script-added elements from the css written for a component', async () => {
    const canvas = newCanvas()
    const made = await call('create_component', {
      canvas_id: canvas.id,
      name: 'FAQ Row',
      html: '<details class="faq-row"><summary class="q">Question</summary><p class="a">Answer</p></details>',
      css:
        '.faq-row { border-bottom: 1px solid #ddd } .faq-row[open] summary::after { content: "−" } .faq-row .copied-toast { opacity: 1 } ' +
        'details[open] > summary { font-weight: 600 } .hero h1 { font-size: 72px } .nope { color: green }',
    })
    expect(made.isError).toBe(false)
    const faq = findComponent(canvas.id, 'FAQ Row')!
    expect(faq.rawCss).toContain('.faq-row[open] summary::after { content: "−" }')
    expect(faq.rawCss).toContain('.faq-row .copied-toast { opacity: 1 }')
    expect(faq.rawCss).toContain('details[open] > summary { font-weight: 600 }')
    /* not about this component: a page's rule pasted along, and a typo, are left out and named */
    expect(faq.rawCss).not.toContain('.hero')
    expect(faq.rawCss).not.toContain('.nope')
    expect(made.text).toContain('were not kept: .hero h1, .nope')
    expect(made.text).toContain('were kept for a state it is not in yet or an element a script adds')
    /* scoped, so it can never reach outside an instance: every selector of every kept rule names it */
    const scope = `[data-doop-instance="${faq.id}"]`
    for (const rule of faq.css.split('\n').filter((line) => line.includes('{') && !line.startsWith('@'))) {
      for (const selector of rule.slice(0, rule.indexOf('{')).split(/,(?![^(]*\))/)) expect(selector).toContain(scope)
    }

    /* The white ::after belongs to an open FAQ instance under the dark theme. */
    const themed = await call('update_component', {
      canvas_id: canvas.id,
      component: 'FAQ Row',
      css: `${faq.rawCss}\nhtml.dark .faq-row[open] summary::after { color: white }`,
    })
    expect(themed.isError).toBe(false)
    const css = findComponent(canvas.id, 'FAQ Row')!.css
    const whiteRule = css.match(/^([^{}\n]+)\s*\{\s*color:\s*white\s*;?\s*\}/m)
    expect(whiteRule).toBeTruthy()
    const subjects = splitTopLevel(whiteRule![1]!, ',').map((selector) => {
      expect(selector).toMatch(/::after$/)
      return selector.replace(/::after$/, '')
    })
    function matchesSummary(theme: string, state: string, instance: string) {
      const doc = parse(`<html class="${theme}"><body>
        <details class="faq-row" ${state} data-doop-instance="${instance}"><summary>Question</summary></details>`)
      const summary = resolveElement(doc, 'body > details > summary')!
      return subjects.some((selector) => elementIs(summary, selector))
    }
    expect(matchesSummary('dark', 'open', faq.id)).toBe(true)
    expect(matchesSummary('light', 'open', faq.id)).toBe(false)
    expect(matchesSummary('dark', '', faq.id)).toBe(false)
    expect(matchesSummary('dark', 'open', 'other')).toBe(false)

    const page = await framed(
      canvas.id,
      '<style>.hero { padding: 80px } .stat { color: red } .stat.is-up .arrow { color: green }</style>' +
        '<section class="hero"><div class="stat" data-doop-id="stat-one"><b class="value">12</b></div></section>',
    )
    const fromPage = await call('create_component', {
      canvas_id: canvas.id,
      name: 'Stat',
      frame_id: page,
      element: 'stat-one',
    })
    expect(fromPage.isError).toBe(false)
    const stat = findComponent(canvas.id, 'Stat')!
    expect(stat.rawCss).toContain('.stat { color: red }')
    /* the page's own rule for another element is not the component's */
    expect(stat.rawCss).not.toContain('.hero')
  })

  /* each component keeps the css written for it, and only that: two mains on one page whose
     blocks share a selector do not take each other's rules */
  it('keeps one component’s css out of another’s on the same page', async () => {
    const canvas = newCanvas()
    const page = await framed(
      canvas.id,
      '<div class="item" data-doop-id="item-a"><i class="chev">a</i></div>' +
        '<div class="item" data-doop-id="item-b"><i class="chev">b</i></div>',
    )
    for (const [name, element, rule] of [
      ['A', 'item-a', '.item[open] .chev { rotate: 90deg }'],
      ['B', 'item-b', '.item[open] .chev { color: red }'],
    ] as const) {
      expect((await call('create_component', { canvas_id: canvas.id, name, frame_id: page, element })).isError).toBe(
        false,
      )
      expect((await call('update_component', { canvas_id: canvas.id, component: name, css: rule })).isError).toBe(false)
    }
    expect(findComponent(canvas.id, 'A')!.rawCss).toContain('rotate: 90deg')
    expect(findComponent(canvas.id, 'A')!.rawCss).not.toContain('color: red')
    expect(findComponent(canvas.id, 'B')!.rawCss).toContain('color: red')
    expect(findComponent(canvas.id, 'B')!.rawCss).not.toContain('rotate: 90deg')
  })

  it('says where it could not read a component’s CSS past', async () => {
    const canvas = newCanvas()
    const made = await call('create_component', {
      canvas_id: canvas.id,
      name: 'Quote',
      html: '<blockquote class="q"><p class="body">Hi</p></blockquote>',
      css: ".q { padding: 8px } .q::before { content: 'open } .body { color: red }",
    })
    expect(made.isError).toBe(false)
    expect(made.text).toContain('COMPONENT: the CSS for “Quote” could not be read past: .q::before')

    const tailwind = await call('update_component', {
      canvas_id: canvas.id,
      component: 'Quote',
      css: String.raw`.q { padding: 8px } .\[\&_p\:not\(\[class\*\=\'x\'\]\)\]\:m-0 p { margin: 0 } .body { color: red }`,
    })
    expect(tailwind.text).not.toContain('could not be read')
    expect(findComponent(canvas.id, 'Quote')!.rawCss).toContain('color: red')
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
