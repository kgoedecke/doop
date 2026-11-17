import { afterEach, describe, expect, it, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type { ComponentDef } from '../shared/components.ts'
import type { ActivityItem, Actor, Canvas, Frame, FrameVersion, ServerMessage } from '../shared/types.ts'

/* The database, as far as this file needs one: what each persist call would leave in its
   table. A refused operation must leave it exactly as it was, and after any operation it
   must hold what memory holds. */
const db = vi.hoisted(() => ({
  frames: new Map<string, { canvasId: string; name: string; html: string }>(),
  components: new Map<string, { canvasId: string; id: string; row: string }>(),
  pages: new Map<string, string>(),
  activity: new Map<string, string[]>(),
  versions: new Map<string, unknown>(),
  library: new Map<string, { canvasId: string; id: string; rev: number }>(),
  tasks: new Map<string, { canvasId: string; row: string }>(),
  tokens: new Map<string, { canvasId: string; row: string }>(),
}))

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: (c: Canvas) => void db.pages.set(c.id, JSON.stringify(c.pages ?? null)),
  saveFrame: (f: Frame) => void db.frames.set(f.id, { canvasId: f.canvasId, name: f.name, html: f.html }),
  deleteFrame: (id: string) => void db.frames.delete(id),
  saveActivity: (canvasId: string, item: ActivityItem) =>
    void db.activity.set(canvasId, [item.id, ...(db.activity.get(canvasId) ?? [])]),
  saveFrameVersion: (version: FrameVersion) => void db.versions.set(version.id, version),
  getFrameVersion: (_frameId: string, versionId: string) => Promise.resolve(db.versions.get(versionId)),
  saveTask: (canvasId: string, task: { id: string }) =>
    void db.tasks.set(task.id, { canvasId, row: JSON.stringify(task) }),
  saveComponent: (canvasId: string, def: ComponentDef) =>
    void db.components.set(`${canvasId}:${def.id}`, { canvasId, id: def.id, row: JSON.stringify(def) }),
  deleteComponent: (canvasId: string, id: string) => void db.components.delete(`${canvasId}:${id}`),
  saveLibraryComponent: (snapshot: { canvasId: string; id: string; rev: number }) =>
    void db.library.set(`${snapshot.canvasId}:${snapshot.id}`, {
      canvasId: snapshot.canvasId,
      id: snapshot.id,
      rev: snapshot.rev,
    }),
  deleteLibraryComponent: (canvasId: string, id: string) => void db.library.delete(`${canvasId}:${id}`),
  saveToken: (canvasId: string, token: { name: string }) =>
    void db.tokens.set(`${canvasId}:${token.name}`, { canvasId, row: JSON.stringify(token) }),
  deleteToken: (canvasId: string, name: string) => void db.tokens.delete(`${canvasId}:${name}`),
  saveFeedback: () => {},
  saveComment: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveGuideline: () => {},
  saveGuidelineVersion: () => {},
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
import { publishedOn, publishLibrary } from '../server/componentLibrary.ts'
import {
  changeInstances,
  createComponentFromElement,
  createComponentFromHtml,
  deleteComponent,
  detachAllInstances,
  importComponent,
  insertInstance,
  restoreComponent,
  updateComponent,
} from '../server/componentActions.ts'
import { componentWriteNotes, runComponentTool, type ToolContext } from '../server/componentTools.ts'
import { execTool } from '../server/resident.ts'
import { parse, runOperation, WorkBudgetError } from '../server/workBudget.ts'
import { COMPONENT_ATTR } from '../shared/components.ts'
import { canvasPages } from '../shared/pages.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor
const agent = actions.resolveActor({ name: 'Doop', kind: 'agent' })

const doc = (body: string, css = '') =>
  `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`

const framed = (id: string) => store.getFrame(id)!.html

/* what the room is told, per canvas: a refused operation must not have told it anything, and
   after any operation a viewer who replays what it was told must hold what the server holds */
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
  actions.updateFrame(
    more.id,
    {
      html: doc(`<doop-use component="Button" label="Next"></doop-use><p class="tag">Three</p><p class="tag">Four</p>`),
    },
    actor,
  )
  /* another canvas to import from: a Panel built from a Chip */
  const source = store.createCanvas('commit order source')
  const sourceMains = new Map<string, Frame>()
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
    sourceMains.set(name, frame)
  }
  return { canvas, def, mainFrame, page, more, source, sourceMains, library, badgeMain }
}

type Made = ReturnType<typeof setup>

/** Everything of a canvas a refused operation must leave exactly as it was, in memory. */
function memory(canvas: Canvas) {
  return structuredClone({
    frames: canvas.frames.map((frame) => ({ id: frame.id, name: frame.name, html: frame.html, at: frame.updatedAt })),
    components: canvas.components ?? [],
    pages: canvasPages(canvas),
    tokens: canvas.tokens ?? [],
    activity: actions.getActivity(canvas.id).map((item) => item.id),
    tasks: actions.getTasks(canvas.id).map((task) => JSON.stringify(task)),
    streaming: canvas.frames.filter((frame) => actions.isFrameStreaming(frame.id)).map((frame) => frame.id),
    published: publishedOn(canvas.id).map((entry) => `${entry.id}:${entry.rev}`),
    queued: propagation.pendingFrames(canvas.id),
  })
}

const sorted = <T>(rows: T[]) => rows.map((row) => JSON.stringify(row)).sort()

/** The same canvas as the database holds it. */
function stored(canvas: Canvas) {
  const mine = <T extends { canvasId: string }>(rows: Map<string, T>) =>
    [...rows].filter(([, row]) => row.canvasId === canvas.id)
  return {
    frames: sorted(mine(db.frames).map(([id, row]) => ({ id, name: row.name, html: row.html }))),
    components: sorted(mine(db.components).map(([, row]) => row.row)),
    pages: db.pages.get(canvas.id),
    activity: [...(db.activity.get(canvas.id) ?? [])],
    published: sorted(mine(db.library).map(([, row]) => `${row.id}:${row.rev}`)),
    tasks: sorted(mine(db.tasks).map(([, row]) => row.row)),
    tokens: sorted(mine(db.tokens).map(([, row]) => row.row)),
  }
}

/** What the database should hold for the canvas, given what memory holds. */
function storedFrom(canvas: Canvas): ReturnType<typeof stored> {
  return {
    frames: sorted(canvas.frames.map((frame) => ({ id: frame.id, name: frame.name, html: frame.html }))),
    components: sorted((canvas.components ?? []).map((def) => JSON.stringify(def))),
    pages: JSON.stringify(canvas.pages ?? null),
    activity: actions.getActivity(canvas.id).map((item) => item.id),
    published: sorted(publishedOn(canvas.id).map((entry) => `${entry.id}:${entry.rev}`)),
    tasks: sorted(actions.getTasks(canvas.id).map((task) => JSON.stringify(task))),
    tokens: sorted((canvas.tokens ?? []).map((token) => JSON.stringify(token))),
  }
}

const componentKey = (def: ComponentDef) => `${def.rev}:${def.status ?? 'active'}:${def.name}`

interface Viewed {
  frames: Record<string, string>
  components: Record<string, string>
  pages: string
  activity: string[]
}

/** What a viewer holds who joined when the canvas was `canvas` and has heard nothing since. */
function viewing(canvas: Canvas): Viewed {
  return {
    frames: Object.fromEntries(canvas.frames.map((frame) => [frame.id, frame.html])),
    components: Object.fromEntries((canvas.components ?? []).map((def) => [def.id, componentKey(def)])),
    pages: JSON.stringify(canvasPages(canvas)),
    activity: actions.getActivity(canvas.id).map((item) => item.id),
  }
}

/** A viewer's copy of the canvas after the broadcasts it was sent. */
function replay(before: Viewed, messages: ServerMessage[]): Viewed {
  const view = structuredClone(before)
  for (const message of messages) {
    if (message.type === 'frame:created' || message.type === 'frame:updated')
      view.frames[message.frame.id] = message.frame.html
    else if (message.type === 'frame:deleted') delete view.frames[message.frameId]
    else if (message.type === 'component') {
      if (message.component) view.components[message.id] = componentKey(message.component)
      else delete view.components[message.id]
    } else if (message.type === 'canvas:pages') view.pages = JSON.stringify(message.pages)
    else if (message.type === 'activity') view.activity.unshift(message.item.id)
  }
  return view
}

const context = (canvas: Canvas): ToolContext => ({
  canvas,
  actor,
  canRead: () => true,
  canEdit: () => true,
  readableCanvases: () => [canvas],
  userId: undefined,
})

/** A tool call as MCP and the resident agent make it: a refusal comes back as its error. */
async function tool(name: string, input: Record<string, unknown>, canvas: Canvas) {
  const outcome = await runComponentTool(name, input, context(canvas))
  if (!outcome.ok) throw new Error(`refused: ${outcome.error}`)
  return outcome
}

const runState = () => ({
  mutatedFrames: new Set<string>(),
  sourceFrames: new Set<string>(),
  verificationFrames: new Set<string>(),
  verifiedFrames: new Set<string>(),
  seenVerified: new Set<string>(),
  rewriteDrafts: new Map<string, string>(),
  vision: false,
  imagesGenerated: 0,
  repliedThreads: new Set<string>(),
  awaitingThreads: new Set<string>(),
  tokenWrites: 0,
  arrangeWrites: 0,
})

/** A tool call as the resident agent's runner makes it (its own operation): a refusal comes
 *  back as an error result. */
async function resident(name: string, input: Record<string, unknown>, canvas: Canvas) {
  const block: Anthropic.ToolUseBlockParam = { type: 'tool_use', id: 't1', name, input }
  const result = await execTool(block, canvas.id, agent, runState() as never)
  if (result.is_error) throw new Error(`refused: ${JSON.stringify(result.content)}`)
  return result
}

const STREAM_HEAD = '<!doctype html><html><head></head><body><p>streamed</p>'

const idle = () => propagation.whenIdle()

/** The page takes up the library's Badge, then the library moves it on and publishes again. */
async function behindItsLibrary({ page, library, badgeMain }: Made) {
  actions.updateFrame(
    page.id,
    { html: framed(page.id).replace('</body>', '<doop-use component="Badge"></doop-use></body>') },
    actor,
  )
  await idle()
  actions.updateFrame(badgeMain.id, { html: framed(badgeMain.id).replace('New', 'Newer') }, actor)
  await idle()
  publishLibrary(library, undefined, 'Tester')
}

/** A version of the page to go back to: its design is replaced, which files the one before. */
function replaced({ page }: Made) {
  actions.updateFrame(page.id, { html: doc('<h1>Another design altogether</h1>') }, actor, { replace: true })
  const version = [...db.versions.values()].at(-1) as FrameVersion
  return version.id
}

interface Case {
  /** what has to be in place first, done with nothing slow and before the snapshot */
  prepare?: (made: Made) => unknown
  run: (made: Made, prepared: unknown) => unknown
  /** the canvases it may write, when not only the one it is called on */
  canvases?: (made: Made) => Canvas[]
}

/** Every operation that writes, each as a request, a tool call or a timer would run it. */
const OPERATIONS: Record<string, Case> = {
  /* ---- frame writes ---- */
  'create_frame with components, one from the library': {
    run: ({ canvas }) =>
      actions.createFrame(
        canvas.id,
        { name: 'New', html: doc('<doop-use component="Button"></doop-use><doop-use component="Badge"></doop-use>') },
        actor,
      ),
  },
  'a frame write that changes a main': {
    run: ({ mainFrame }) =>
      actions.updateFrame(
        mainFrame.id,
        { html: framed(mainFrame.id).replace('class="btn"', 'class="btn big"') },
        actor,
      ),
  },
  'a frame write that takes up a library component': {
    run: ({ page }) =>
      actions.updateFrame(
        page.id,
        { html: framed(page.id).replace('</body>', '<doop-use component="Badge"></doop-use></body>') },
        actor,
      ),
  },
  'a frame write, then the notes an agent is given about it': {
    run: ({ page }) => {
      const frame = actions.updateFrame(page.id, { html: framed(page.id).replace('One', 'Uno') }, actor)!
      return componentWriteNotes(frame, { review: true })
    },
  },
  'deleting the frame that holds a main': {
    run: ({ mainFrame }) => actions.deleteFrame(mainFrame.id, actor),
  },
  'restoring a frame version': {
    prepare: replaced,
    run: ({ page }, versionId) => actions.restoreFrameVersion(page.id, versionId as string, actor),
  },
  /* ---- streams ---- */
  'a stream chunk that uses a canvas component': {
    run: ({ page }) =>
      actions.appendFrameHtml(page.id, `${STREAM_HEAD}<doop-use component="Button"></doop-use>`, actor, {
        start: true,
      }),
  },
  'a stream chunk that takes up a library component': {
    run: ({ page }) =>
      actions.appendFrameHtml(page.id, `${STREAM_HEAD}<doop-use component="Badge"></doop-use>`, actor, {
        start: true,
      }),
  },
  'the last chunk of a stream, taking up a library component': {
    prepare: ({ page }) => actions.appendFrameHtml(page.id, STREAM_HEAD, actor, { start: true }),
    run: ({ page }) =>
      actions.appendFrameHtml(
        page.id,
        '<doop-use component="Badge"></doop-use><doop-use component="Button"></doop-use></body></html>',
        actor,
        { done: true },
      ),
  },
  'the last chunk of a stream that wrote a main': {
    prepare: ({ mainFrame }) =>
      actions.appendFrameHtml(mainFrame.id, framed(mainFrame.id).replace('</body></html>', ''), actor, {
        start: true,
      }),
    run: ({ mainFrame }) =>
      actions.appendFrameHtml(mainFrame.id, '<p>and more</p></body></html>', actor, { done: true }),
  },
  'a stream nobody closed, settled when it goes idle': {
    prepare: ({ page }) =>
      actions.appendFrameHtml(
        page.id,
        `${STREAM_HEAD}<doop-use component="Badge"></doop-use><doop-use component="Button"></doop-use>`,
        actor,
        { start: true },
      ),
    run: () => actions.expireIdleStreams(Date.now() + 10 * 60_000),
  },
  /* ---- components: the tools, as MCP and the resident agent share them ---- */
  'create_component (the tool) from markup': {
    run: ({ canvas }) =>
      tool(
        'create_component',
        {
          name: 'List',
          html: '<ul class="list"><li class="row"><b>A</b><i>1</i></li><li class="row"><b>B</b><i>2</i></li><li class="row"><b>C</b><i>3</i></li></ul>',
          css: '.list { margin: 0 }',
        },
        canvas,
      ),
  },
  'create_components (the tool), one nesting the other': {
    run: ({ canvas }) =>
      tool(
        'create_components',
        {
          components: [
            { name: 'Chip', html: '<span class="chip">New</span>', css: '.chip { padding: 2px 6px }' },
            {
              name: 'Row',
              html: '<div class="row"><b>Title</b><doop-use component="Chip"></doop-use></div>',
              css: '.row { display: flex }',
            },
          ],
        },
        canvas,
      ),
  },
  'create_component (the tool) with replace_matching': {
    run: ({ canvas, page }) =>
      tool('create_component', { name: 'Tag', frame_id: page.id, element: 'tagone', replace_matching: true }, canvas),
  },
  'update_component (the tool)': {
    run: ({ canvas }) =>
      tool('update_component', { component: 'Button', find: 'class="btn"', replace: 'class="btn big"' }, canvas),
  },
  'insert_instance (the tool)': {
    run: ({ canvas, page }) => tool('insert_instance', { frame_id: page.id, component: 'Button' }, canvas),
  },
  'update_instances (the tool)': {
    run: ({ canvas, page }) =>
      tool(
        'update_instances',
        { frame_id: page.id, instances: [{ instance_id: 'inst01', props: { label: 'Stop' } }] },
        canvas,
      ),
  },
  'delete_component (the tool)': {
    run: ({ canvas }) => tool('delete_component', { component: 'Button' }, canvas),
  },
  'delete_component (the tool) detaching every instance': {
    run: ({ canvas }) => tool('delete_component', { component: 'Button', detach_instances: true }, canvas),
  },
  'restore_component (the tool)': {
    prepare: ({ canvas }) => deleteComponent(canvas.id, 'Button', actor),
    run: ({ canvas }) => tool('restore_component', { component: 'Button' }, canvas),
  },
  'restore_component (the tool) when its main is gone': {
    prepare: ({ canvas, mainFrame }) => {
      deleteComponent(canvas.id, 'Button', actor)
      actions.deleteFrame(mainFrame.id, actor)
    },
    run: ({ canvas }) => tool('restore_component', { component: 'Button' }, canvas),
  },
  'restore_component_version (the tool)': {
    prepare: ({ canvas }) =>
      updateComponent(
        canvas.id,
        'Button',
        { html: '<button class="btn later"><span data-doop-prop="label">Buy</span></button>' },
        actor,
      ),
    run: ({ canvas }) => tool('restore_component_version', { component: 'Button', rev: 1 }, canvas),
  },
  'import_component (the tool) with what it is built from': {
    run: ({ canvas, source }) => tool('import_component', { source_canvas_id: source.id, component: 'Panel' }, canvas),
  },
  'sync_component (the tool): an import whose origin and what it is built from moved': {
    prepare: async ({ canvas, source, sourceMains }) => {
      importComponent(canvas.id, source.id, 'Panel', actor)
      await idle()
      for (const [name, frame] of sourceMains) {
        actions.updateFrame(frame.id, { html: framed(frame.id).replace(`>${name}<`, `>${name} two<`) }, actor)
        await idle()
      }
    },
    run: ({ canvas }) => tool('sync_component', { component: 'Panel' }, canvas),
  },
  'sync_component (the tool): a pull from the workspace library': {
    prepare: behindItsLibrary,
    run: ({ canvas }) => tool('sync_component', { component: 'Badge' }, canvas),
  },
  'publish_library (the tool)': {
    prepare: async ({ badgeMain }) => {
      actions.updateFrame(badgeMain.id, { html: framed(badgeMain.id).replace('New', 'Newer') }, actor)
      await idle()
    },
    run: ({ library }) => tool('publish_library', {}, library),
    canvases: ({ library }) => [library],
  },
  'update_library_everywhere (the tool)': {
    prepare: behindItsLibrary,
    run: ({ library }) => tool('update_library_everywhere', {}, library),
    canvases: ({ library, canvas }) => [library, canvas],
  },
  /* ---- components: the functions the REST routes call ---- */
  'update_component: props only': {
    run: ({ canvas }) =>
      updateComponent(
        canvas.id,
        'Button',
        { name: 'Action', props: [{ name: 'tone', type: 'enum', options: ['a', 'b'] }] },
        actor,
      ),
  },
  'update_component: css only': {
    run: ({ canvas }) =>
      updateComponent(canvas.id, 'Button', { css: '.btn { padding: 2px } .nothing { color: red }' }, actor),
  },
  'update_component: markup, css and props': {
    run: ({ canvas }) =>
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
  },
  'create_component from markup': {
    run: ({ canvas }) =>
      createComponentFromHtml(
        canvas.id,
        { name: 'Chip', html: '<span class="chip">Chip</span>', css: '.chip { color: red } .unused { color: blue }' },
        actor,
      ),
  },
  'create_component from an element': {
    run: ({ canvas, page }) =>
      createComponentFromElement(canvas.id, { name: 'Tag', frameId: page.id, element: 'tagone' }, actor),
  },
  'create_component with replace_matching': {
    run: ({ canvas, page }) =>
      createComponentFromElement(
        canvas.id,
        { name: 'Tag', frameId: page.id, element: 'tagone', replaceMatching: true },
        actor,
      ),
  },
  'import_component with what it is built from': {
    run: ({ canvas, source }) => importComponent(canvas.id, source.id, 'Panel', actor),
  },
  insert_instance: {
    run: ({ canvas, page }) => insertInstance(canvas.id, { frameId: page.id, component: 'Button' }, actor),
  },
  'update_instances (the function)': {
    run: ({ canvas, page }) =>
      changeInstances(canvas.id, page.id, [{ instanceId: 'inst01', props: { label: 'Stop' } }], actor),
  },
  restore_component: {
    prepare: ({ canvas }) => deleteComponent(canvas.id, 'Button', actor),
    run: ({ canvas }) => restoreComponent(canvas.id, 'Button', actor),
  },
  'detaching every instance of a component': {
    run: ({ canvas }) => detachAllInstances(canvas.id, 'Button', actor),
  },
  /* ---- tokens: a change restyles every frame naming the token ---- */
  'creating a token the frames then carry': {
    run: ({ canvas }) => actions.createTokens(canvas.id, [{ name: '--brand', type: 'color', value: '#0177d3' }], actor),
  },
  /* ---- the resident agent's own tools, each an operation of its own ---- */
  'resident create_frame': {
    run: ({ canvas }) =>
      resident(
        'create_frame',
        { name: 'Hero', html: doc('<doop-use component="Button"></doop-use><doop-use component="Badge"></doop-use>') },
        canvas,
      ),
  },
  'resident edit_frame_html': {
    run: ({ canvas, page }) => resident('edit_frame_html', { frame_id: page.id, find: 'One', replace: 'Uno' }, canvas),
  },
  'resident set_frame_html of a main': {
    run: ({ canvas, mainFrame }) =>
      resident(
        'set_frame_html',
        { frame_id: mainFrame.id, html: framed(mainFrame.id).replace('class="btn"', 'class="btn big"') },
        canvas,
      ),
  },
  'resident update_component': {
    run: ({ canvas }) =>
      resident('update_component', { component: 'Button', find: 'class="btn"', replace: 'class="btn big"' }, canvas),
  },
  'resident create_component from markup': {
    run: ({ canvas }) =>
      resident(
        'create_component',
        { name: 'List', html: '<ul class="list"><li>A</li><li>B</li></ul>', css: '.list { margin: 0 }' },
        canvas,
      ),
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

/** One run of a case with its Nth parse slow (0: none), and what it left. */
async function attempt(name: string, at: number) {
  const made = setup()
  await idle()
  const prepared = await OPERATIONS[name]!.prepare?.(made)
  await idle()
  const canvases = OPERATIONS[name]!.canvases?.(made) ?? [made.canvas]
  const before = canvases.map((canvas) => ({
    canvas,
    memory: memory(canvas),
    stored: stored(canvas),
    view: viewing(canvas),
  }))
  for (const canvas of canvases) told.delete(canvas.id)
  slow.parses = 0
  slow.offset = 0
  slow.at = at
  let refused: Error | undefined
  try {
    await runOperation(name, made.canvas.id, () => OPERATIONS[name]!.run(made, prepared))
  } catch (error) {
    refused = error as Error
  }
  /* the background queue is part of what the operation set going: its frames are swept too */
  await idle()
  slow.at = 0
  return { before, refused, parses: slow.parses }
}

/** Whatever happened, the three copies of a canvas agree: memory, the database, a viewer. */
function expectConsistent(before: Awaited<ReturnType<typeof attempt>>['before'], label: string) {
  for (const { canvas, view } of before) {
    expect(stored(canvas), `the database, ${label}`).toEqual(storedFrom(canvas))
    const viewer = replay(view, told.get(canvas.id) ?? [])
    const server = viewing(canvas)
    /* a frame mid-stream or mid-reveal is shown as far as it has got, healed */
    for (const frame of canvas.frames) {
      if (!actions.isFrameStreaming(frame.id)) continue
      delete viewer.frames[frame.id]
      delete server.frames[frame.id]
    }
    expect(viewer, `the room, ${label}`).toEqual(server)
  }
}

describe('an operation that runs out of budget at any parse', () => {
  for (const name of Object.keys(OPERATIONS)) {
    it(`${name}: lands whole, or is refused with nothing changed anywhere`, async () => {
      ownClock()
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      /* how many parses it takes when nothing is slow, its background work included */
      const rehearsal = await attempt(name, 0)
      expect(rehearsal.refused, 'with nothing slow').toBeUndefined()
      expectConsistent(rehearsal.before, 'with nothing slow')

      let stopped = 0
      for (let at = 1; at <= rehearsal.parses; at++) {
        const label = `parse ${at} of ${rehearsal.parses}`
        logged.mockClear()
        const { before, refused } = await attempt(name, at)
        /* a frame of the queue, or an idle stream, that was skipped for its budget */
        if (refused || logged.mock.calls.some(([line]) => /was stopped/.test(String(line)))) stopped += 1
        expectConsistent(before, label)
        if (!refused) continue
        expect(refused.message, label).toContain('was stopped')
        /* it kept part of its work, by design, and says so: the copies agree, checked above */
        if (!refused.message.includes('Nothing was changed')) {
          expect(refused.message, label).toContain('It stopped part of the way')
          continue
        }
        for (const { canvas, memory: was, stored: rows } of before) {
          expect(memory(canvas), `memory, ${label}`).toEqual(was)
          expect(stored(canvas), `the database, ${label}`).toEqual(rows)
          /* and nobody watching was told anything at all */
          expect(told.get(canvas.id) ?? [], `the room, ${label}`).toEqual([])
        }
      }
      /* the sweep means something only if the budget did bite somewhere */
      if (rehearsal.parses) expect(stopped).toBeGreaterThan(0)
    })
  }
})

describe('what the write boundary closed', () => {
  it('a refused create_component leaves no Components page behind', async () => {
    ownClock()
    let refusals = 0
    for (let at = 1; at <= 12; at++) {
      const { before, refused } = await attempt('create_component from markup', at)
      if (!refused) continue
      refusals += 1
      const [{ canvas, memory: was }] = before as [(typeof before)[number]]
      expect(canvasPages(canvas).map((page) => page.name)).toEqual(was.pages.map((page) => page.name))
      expect(db.pages.get(canvas.id)).not.toContain('Components')
    }
    expect(refusals).toBeGreaterThan(0)
  })

  it('a refused write leaves no line in the activity feed, in memory or stored', async () => {
    ownClock()
    let refusals = 0
    for (let at = 1; at <= 12; at++) {
      const { before, refused } = await attempt('update_component: markup, css and props', at)
      if (!refused) continue
      refusals += 1
      const [{ canvas, memory: was, stored: rows }] = before as [(typeof before)[number]]
      expect(actions.getActivity(canvas.id).map((item) => item.id)).toEqual(was.activity)
      expect(db.activity.get(canvas.id) ?? []).toEqual(rows.activity)
    }
    expect(refusals).toBeGreaterThan(0)
  })

  it('a refused stream chunk keeps none of the library components it took up', async () => {
    ownClock()
    let refusals = 0
    for (let at = 1; at <= 12; at++) {
      const { before, refused } = await attempt('a stream chunk that takes up a library component', at)
      if (!refused) continue
      refusals += 1
      const [{ canvas }] = before as [(typeof before)[number]]
      expect((canvas.components ?? []).map((def) => def.name)).toEqual(['Button'])
      expect(actions.isFrameMidStream(canvas.frames[1]!.id)).toBe(false)
    }
    expect(refusals).toBeGreaterThan(0)
  })
})

describe('a refusal while a main is being updated', () => {
  it('saves no props, name or revision when the template cannot be read within budget', () => {
    const { canvas, def } = setup()
    stubEnv('DOOP_WORK_BUDGET_PARSE_MB', '1')
    const before = memory(canvas)
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
    expect(memory(canvas)).toEqual(before)
  })
})

describe('work that is optional once a change has landed', () => {
  it('keeps a finished replace_matching partial, and says it stopped', async () => {
    ownClock()
    let stopped = 0
    for (let at = 1; at <= 40; at++) {
      const { canvas, page } = setup()
      await propagation.whenIdle()
      const view = viewing(canvas)
      told.delete(canvas.id)
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
      /* and stored and shown as such: each finished part was committed */
      expect(stored(canvas)).toEqual(storedFrom(canvas))
      expect(replay(view, told.get(canvas.id) ?? [])).toEqual(viewing(canvas))
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

  it('keeps what an import had brought up to date when a later component is refused, and says so', async () => {
    ownClock()
    const name = 'sync_component (the tool): an import whose origin and what it is built from moved'
    let partial = 0
    for (let at = 1; at <= 60; at++) {
      const { before, refused } = await attempt(name, at)
      if (!refused?.message.includes('It stopped part of the way')) continue
      partial += 1
      const [{ canvas }] = before as [(typeof before)[number]]
      /* what it names as updated is updated, here and for everyone */
      expect(refused.message).toContain('“Chip” updated')
      expect(canvas.components?.find((def) => def.name === 'Chip')?.template).toContain('Chip two')
      expect(canvas.components?.find((def) => def.name === 'Panel')?.template).not.toContain('Panel two')
    }
    expect(partial).toBeGreaterThan(0)
  })
})
