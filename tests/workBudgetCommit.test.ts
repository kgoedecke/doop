import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
  deleteFrame: () => {},
  saveLibraryComponent: () => {},
  deleteLibraryComponent: () => {},
  saveToken: () => {},
}))

/* a workspace is its id here (a real one lives in the database), and every one has a library */
vi.mock('../server/workspaces.ts', async (original) => ({
  ...(await original<typeof import('../server/workspaces.ts')>()),
  getWorkspace: (id: string) => ({ id, name: 'Team' }),
  isActive: () => true,
  mayPublishLibrary: () => true,
}))

/* A clock the test owns, and a parser that can be made slow on its Nth call: the Nth parse of
   an operation then costs more than the whole time budget, wherever in the operation it falls. */
const slow = vi.hoisted(() => ({ parses: 0, at: 0, offset: 0 }))

vi.mock('parse5', async (original) => {
  const real = await original<typeof import('parse5')>()
  const counted =
    <A extends unknown[], R>(run: (...args: A) => R) =>
    (...args: A): R => {
      slow.parses += 1
      if (slow.parses === slow.at) slow.offset += 60_000
      return run(...args)
    }
  return {
    ...real,
    parse: counted(real.parse as (...args: unknown[]) => unknown),
    parseFragment: counted(real.parseFragment as (...args: unknown[]) => unknown),
  }
})

import { store } from '../server/store.ts'
import * as actions from '../server/actions.ts'
import * as propagation from '../server/propagation.ts'
import { blankComponent } from '../server/components.ts'
import { publishLibrary } from '../server/componentLibrary.ts'
import {
  changeInstances,
  createComponentFromElement,
  createComponentFromHtml,
  importComponent,
  insertInstance,
  deleteComponent,
  restoreComponent,
  updateComponent,
} from '../server/componentActions.ts'
import { componentWriteNotes, runComponentTool, type ToolContext } from '../server/componentTools.ts'
import { parse, runOperation, WorkBudgetError } from '../server/workBudget.ts'
import { COMPONENT_ATTR } from '../shared/components.ts'
import type { Actor, Canvas, ServerMessage } from '../shared/types.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor

const doc = (body: string, css = '') =>
  `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`

const framed = (id: string) => store.getFrame(id)!.html

/* what the room is told, per canvas: a refused operation must not have told it anything that
   leaves a viewer's canvas different from the server's */
const told = new Map<string, ServerMessage[]>()
actions.wire(
  (canvasId, message) => {
    const list = told.get(canvasId)
    if (list) list.push(message)
    else told.set(canvasId, [message])
  },
  () => {},
)

let workspaces = 0

function setup() {
  const canvas = store.createCanvas('commit order test')
  /* in a workspace whose library publishes a Badge this canvas has not used yet */
  const workspaceId = `ws-commit-${++workspaces}`
  store.setWorkspace(canvas.id, workspaceId)
  const library = store.createCanvas('commit order library')
  store.setWorkspace(library.id, workspaceId)
  const badge = blankComponent({ name: 'Badge', by: 'Tester' })
  store.saveComponent(library.id, badge)
  const badgeMain = actions.createFrame(library.id, { name: 'Badge', html: '' }, actor)!
  actions.updateFrame(
    badgeMain.id,
    { html: doc(`<b class="badge" ${COMPONENT_ATTR}="${badge.id}">New</b>`, '.badge { color: green }') },
    actor,
  )
  publishLibrary(library, undefined, 'Tester')
  const def = blankComponent({ name: 'Button', by: 'Tester' })
  store.saveComponent(canvas.id, def)
  const mainFrame = actions.createFrame(canvas.id, { name: 'Main', html: '' }, actor)!
  actions.updateFrame(
    mainFrame.id,
    {
      html: doc(
        `<button class="btn" ${COMPONENT_ATTR}="${def.id}"><span data-doop-prop="label">Buy</span></button>`,
        '.btn { padding: 8px }',
      ),
    },
    actor,
  )
  const page = actions.createFrame(canvas.id, { name: 'Page', html: '' }, actor)!
  actions.updateFrame(
    page.id,
    {
      html: doc(
        `<doop-use component="Button" label="Go" id="inst01"></doop-use><p class="tag" data-doop-id="tagone">One</p><p class="tag">Two</p>`,
      ),
    },
    actor,
  )
  const more = actions.createFrame(canvas.id, { name: 'More', html: '' }, actor)!
  actions.updateFrame(more.id, { html: doc(`<p class="tag">Three</p><p class="tag">Four</p>`) }, actor)
  /* another canvas to import from: a Panel built from a Chip */
  const source = store.createCanvas('commit order source')
  for (const [name, markup] of [
    ['Chip', `<span class="chip" ${COMPONENT_ATTR}="ID">Chip</span>`],
    ['Panel', `<div class="panel" ${COMPONENT_ATTR}="ID"><h2>Panel</h2><doop-use component="Chip"></doop-use></div>`],
  ] as const) {
    const made = blankComponent({ name, by: 'Tester' })
    store.saveComponent(source.id, made)
    const frame = actions.createFrame(source.id, { name, html: '' }, actor)!
    actions.updateFrame(
      frame.id,
      { html: doc(markup.replace('ID', made.id), `.${name.toLowerCase()} { margin: 1px }`) },
      actor,
    )
  }
  told.delete(canvas.id)
  return { canvas, def, mainFrame, page, more, source }
}

/** A viewer's copy of the canvas, as the broadcasts since `before` would have left it. */
function viewed(before: ReturnType<typeof snapshot>, messages: ServerMessage[]) {
  const frames = new Map(before.frames.map((frame) => [frame.id, frame.html]))
  const components = new Map(
    before.components.map((def) => [def.id, `${def.rev}:${def.status ?? 'active'}:${def.name}`]),
  )
  for (const message of messages) {
    if (message.type === 'frame:created' || message.type === 'frame:updated')
      frames.set(message.frame.id, message.frame.html)
    else if (message.type === 'frame:deleted') frames.delete(message.frameId)
    else if (message.type === 'component') {
      if (message.component)
        components.set(
          message.id,
          `${message.component.rev}:${message.component.status ?? 'active'}:${message.component.name}`,
        )
      else components.delete(message.id)
    }
  }
  return { frames: Object.fromEntries(frames), components: Object.fromEntries(components) }
}

type Made = ReturnType<typeof setup>

/** Everything a refused operation must leave exactly as it was. */
const snapshot = (canvas: Canvas) =>
  structuredClone({
    frames: canvas.frames.map((frame) => ({ id: frame.id, name: frame.name, html: frame.html, at: frame.updatedAt })),
    components: canvas.components ?? [],
  })

const context = (canvas: Canvas): ToolContext => ({
  canvas,
  actor,
  canRead: () => true,
  canEdit: () => true,
  readableCanvases: () => [canvas],
  userId: undefined,
})

/** The operations that write, each as a request would run it. `refused` is how a refusal
 *  shows: thrown, or (for a tool) returned as its error. */
/** A tool call as MCP and the resident agent make it: a refusal comes back as its error. */
async function tool(name: string, input: Record<string, unknown>, canvas: Canvas) {
  const outcome = await runComponentTool(name, input, context(canvas))
  if (!outcome.ok) throw new Error(`refused: ${outcome.error}`)
  return outcome
}

const STREAM_HEAD = '<!doctype html><html><head></head><body><p>streamed</p>'

/** What has to be in place before an operation, done with nothing slow and before the snapshot. */
const PREPARE: Record<string, (made: Made) => void> = {
  'the last chunk of a stream, taking up a library component': ({ page }) => {
    actions.appendFrameHtml(page.id, STREAM_HEAD, actor, { start: true })
  },
}

const OPERATIONS: Record<string, (made: Made) => unknown> = {
  'a stream chunk that takes up a library component': ({ page }) =>
    actions.appendFrameHtml(page.id, `${STREAM_HEAD}<doop-use component="Badge"></doop-use>`, actor, { start: true }),
  'the last chunk of a stream, taking up a library component': ({ page }) =>
    actions.appendFrameHtml(
      page.id,
      '<doop-use component="Badge"></doop-use><doop-use component="Button"></doop-use></body></html>',
      actor,
      { done: true },
    ),
  'create_component (the tool) from markup': ({ canvas }) =>
    tool(
      'create_component',
      {
        name: 'List',
        html: '<ul class="list"><li class="row"><b>A</b><i>1</i></li><li class="row"><b>B</b><i>2</i></li><li class="row"><b>C</b><i>3</i></li></ul>',
        css: '.list { margin: 0 }',
      },
      canvas,
    ),
  'create_component (the tool) with replace_matching': ({ canvas, page }) =>
    tool('create_component', { name: 'Tag', frame_id: page.id, element: 'tagone', replace_matching: true }, canvas),
  'update_component (the tool)': ({ canvas }) =>
    tool('update_component', { component: 'Button', find: 'class="btn"', replace: 'class="btn big"' }, canvas),
  'a frame write that changes a main': ({ mainFrame }) =>
    actions.updateFrame(mainFrame.id, { html: framed(mainFrame.id).replace('class="btn"', 'class="btn big"') }, actor),
  'a frame write, then the notes an agent is given about it': ({ page }) => {
    const frame = actions.updateFrame(page.id, { html: framed(page.id).replace('One', 'Uno') }, actor)!
    return componentWriteNotes(frame, { review: true })
  },
  'update_component: props only': ({ canvas }) =>
    updateComponent(
      canvas.id,
      'Button',
      { name: 'Action', props: [{ name: 'tone', type: 'enum', options: ['a', 'b'] }] },
      actor,
    ),
  'update_component: css only': ({ canvas }) =>
    updateComponent(canvas.id, 'Button', { css: '.btn { padding: 2px } .nothing { color: red }' }, actor),
  'update_component: markup, css and props': ({ canvas }) =>
    updateComponent(
      canvas.id,
      'Button',
      {
        html: '<button class="btn wide"><span data-doop-prop="label">Buy</span></button>',
        css: '.btn { padding: 4px } .gone { color: red }',
        props: [{ name: 'tone', type: 'enum', options: ['a', 'b'] }],
      },
      actor,
    ),
  'create_component from markup': ({ canvas }) =>
    createComponentFromHtml(
      canvas.id,
      { name: 'Chip', html: '<span class="chip">Chip</span>', css: '.chip { color: red } .unused { color: blue }' },
      actor,
    ),
  'create_component from an element': ({ canvas, page }) =>
    createComponentFromElement(canvas.id, { name: 'Tag', frameId: page.id, element: 'tagone' }, actor),
  'create_component with replace_matching': ({ canvas, page }) =>
    createComponentFromElement(
      canvas.id,
      { name: 'Tag', frameId: page.id, element: 'tagone', replaceMatching: true },
      actor,
    ),
  'import_component with what it is built from': ({ canvas, source }) =>
    importComponent(canvas.id, source.id, 'Panel', actor),
  insert_instance: ({ canvas, page }) => insertInstance(canvas.id, { frameId: page.id, component: 'Button' }, actor),
  'update_instances (the function)': ({ canvas, page }) =>
    changeInstances(canvas.id, page.id, [{ instanceId: 'inst01', props: { label: 'Stop' } }], actor),
  'update_instances (the tool)': async ({ canvas, page }) => {
    const outcome = await runComponentTool(
      'update_instances',
      { frame_id: page.id, instances: [{ instance_id: 'inst01', props: { label: 'Stop' } }] },
      context(canvas),
    )
    if (!outcome.ok) throw new Error(`refused: ${outcome.error}`)
    return outcome
  },
}

afterEach(async () => {
  slow.at = 0
  slow.offset = 0
  vi.restoreAllMocks()
  unstubAllEnvs()
  await propagation.whenIdle()
})

function ownClock() {
  const real = performance.now.bind(performance)
  vi.spyOn(performance, 'now').mockImplementation(() => real() + slow.offset)
}

describe('the time budget', () => {
  it('refuses an operation whose last parse took it over, not only the parse after', () => {
    ownClock()
    slow.parses = 0
    slow.at = 1
    let refusal: unknown
    try {
      runOperation('one slow parse', 'canvas-x', () => parse('<p>fine</p>'))
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(WorkBudgetError)
    expect((refusal as WorkBudgetError).reason).toBe('time')
  })

  it('still lets work outside any operation finish, and says so once', () => {
    ownClock()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    slow.parses = 0
    slow.at = 1
    expect(() => parse('<p>fine</p>')).not.toThrow()
    expect(logged).toHaveBeenCalledTimes(1)
  })
})

describe('an operation that runs out of budget at any parse', () => {
  for (const [name, operation] of Object.entries(OPERATIONS)) {
    it(`${name}: either lands whole, or is refused with nothing changed`, async () => {
      ownClock()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      /* how many parses it takes when nothing is slow */
      const rehearsal = setup()
      await propagation.whenIdle()
      slow.parses = 0
      PREPARE[name]?.(rehearsal)
      slow.parses = 0
      await runOperation(name, rehearsal.canvas.id, () => operation(rehearsal))
      const parses = slow.parses
      await propagation.whenIdle()
      expect(parses).toBeGreaterThan(0)

      let refusals = 0
      for (let at = 1; at <= parses; at++) {
        const made = setup()
        await propagation.whenIdle()
        PREPARE[name]?.(made)
        const before = { state: snapshot(made.canvas), ref: made.canvas }
        told.delete(made.canvas.id)
        slow.parses = 0
        slow.offset = 0
        slow.at = at
        let refused: unknown
        try {
          await runOperation(name, made.canvas.id, () => operation(made))
        } catch (error) {
          refused = error
        }
        slow.at = 0
        await propagation.whenIdle()
        if (!refused) continue
        refusals += 1
        expect(String((refused as Error).message), `parse ${at} of ${parses}`).toContain('was stopped')
        expect(snapshot(before.ref), `parse ${at} of ${parses}`).toEqual(before.state)
        /* and nobody watching was told otherwise */
        expect(viewed(before.state, told.get(made.canvas.id) ?? []), `the room, parse ${at} of ${parses}`).toEqual(
          viewed(before.state, []),
        )
      }
      /* the sweep means something only if the budget did bite somewhere */
      expect(refusals).toBeGreaterThan(0)
    })
  }

  it('restore_component: a refusal leaves the definition and every frame as the delete left them', async () => {
    ownClock()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const mainGone of [false, true]) {
      for (let at = 1; at <= 12; at++) {
        const made = setup()
        await propagation.whenIdle()
        deleteComponent(made.canvas.id, 'Button', actor)
        if (mainGone) actions.deleteFrame(made.mainFrame.id, actor)
        const before = snapshot(made.canvas)
        slow.parses = 0
        slow.offset = 0
        slow.at = at
        let refused = false
        try {
          runOperation('restore', made.canvas.id, () => restoreComponent(made.canvas.id, 'Button', actor))
        } catch (error) {
          expect(error).toBeInstanceOf(WorkBudgetError)
          refused = true
        }
        slow.at = 0
        await propagation.whenIdle()
        if (refused) expect(snapshot(made.canvas), `main gone ${mainGone}, parse ${at}`).toEqual(before)
      }
    }
  })
})

describe('a refusal while a main is being updated', () => {
  it('saves no props, name or revision when the template cannot be read within budget', () => {
    const { canvas, def } = setup()
    stubEnv('DOOP_WORK_BUDGET_PARSE_MB', '1')
    const before = snapshot(canvas)
    /* all but a few bytes of the budget are gone before the update begins */
    const filler = `<p>${'x'.repeat(1024 * 1024 - 20)}</p>`.slice(0, 1024 * 1024 - 4)
    expect(() =>
      runOperation('mcp update_component', canvas.id, () => {
        parse(filler)
        return updateComponent(
          canvas.id,
          def.id,
          { name: 'Renamed', props: [{ name: 'tone', type: 'enum', options: ['a', 'b'] }] },
          actor,
        )
      }),
    ).toThrow(WorkBudgetError)
    expect(snapshot(canvas)).toEqual(before)
  })
})

describe('work that is optional once a change has landed', () => {
  it('keeps a finished replace_matching partial, and says it stopped', async () => {
    ownClock()
    let stopped = 0
    for (let at = 1; at <= 40; at++) {
      const { canvas, page } = setup()
      await propagation.whenIdle()
      slow.parses = 0
      slow.offset = 0
      slow.at = at
      let result: ReturnType<typeof createComponentFromElement> | undefined
      try {
        result = runOperation('create', canvas.id, () =>
          createComponentFromElement(
            canvas.id,
            { name: 'Tag', frameId: page.id, element: 'tagone', replaceMatching: true },
            actor,
          ),
        )
      } catch (error) {
        expect(error).toBeInstanceOf(WorkBudgetError)
      }
      slow.at = 0
      await propagation.whenIdle()
      if (!result?.matching_stopped) continue
      stopped += 1
      /* the component is there, and what it reports as linked is linked */
      expect(result.component.rev).toBeGreaterThan(0)
      for (const entry of result.converted)
        expect(framed(entry.frameId)).toContain(`data-doop-instance="${result.component.id}"`)
      expect(result.converted.length).toBeLessThan(2)
    }
    expect(stopped).toBeGreaterThan(0)
  })

  it('applies an instance change even when reading the instances back does not fit', async () => {
    ownClock()
    let applied = 0
    for (let at = 1; at <= 30; at++) {
      const { canvas, page } = setup()
      await propagation.whenIdle()
      slow.parses = 0
      slow.offset = 0
      slow.at = at
      const outcome = await runOperation('update_instances', canvas.id, () =>
        runComponentTool(
          'update_instances',
          { frame_id: page.id, instances: [{ instance_id: 'inst01', props: { label: 'Stop' } }] },
          context(canvas),
        ),
      )
      slow.at = 0
      await propagation.whenIdle()
      const changed = framed(page.id).includes('Stop')
      expect(outcome.ok, `parse ${at}`).toBe(changed)
      if (outcome.ok && !(outcome.result.data as { instances?: unknown }).instances) {
        applied += 1
        expect(outcome.result.note).toContain('get_frame')
      }
    }
    expect(applied).toBeGreaterThan(0)
  })
})
