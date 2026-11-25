import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor, ServerMessage } from '../shared/types'

/* persistence is not under test: what the entry does with an operation is */
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveActivity: () => {},
  saveCanvas: () => {},
  refreshAssetRefs: () => {},
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveFrameVersion: () => {},
  deleteFrame: () => {},
  frameWritePending: () => false,
  getFrameVersion: async () => undefined,
  saveToken: () => {},
  deleteToken: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
  saveLibraryComponent: () => {},
  deleteLibraryComponent: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))
vi.mock('../server/fonts.ts', () => ({ fontsForCanvas: () => [] }))
/* the wait for a canvas's frames, which a test may make fail */
const idle = vi.hoisted(() => ({ fail: undefined as ((canvasId: string) => Error | undefined) | undefined }))
vi.mock('../server/propagation.ts', async (original) => {
  const real = await original<typeof import('../server/propagation.ts')>()
  return {
    ...real,
    whenCanvasIdle: (canvasId: string) => {
      const error = idle.fail?.(canvasId)
      return error ? Promise.reject(error) : real.whenCanvasIdle(canvasId)
    },
  }
})
/* a workspace is its id here (a real one lives in the database), on a plan with a library */
vi.mock('../server/workspaces.ts', async (original) => ({
  ...(await original<typeof import('../server/workspaces.ts')>()),
  getWorkspace: (id: string) => ({ id, name: 'Team' }),
  isActive: () => true,
  mayPublishLibrary: () => true,
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { runCanvasWrite, wireCanvasWrites } = await import('../server/canvasWrites.ts')
const { createComponentFromHtml, publishToLibrary, updateComponent } = await import('../server/componentActions.ts')
const { unpublishLibrary } = await import('../server/componentLibrary.ts')
const { updateLibraryConsumers } = await import('../server/libraryUpdates.ts')
const { openTransaction } = await import('../server/journal.ts')
const { runOperation, WorkBudgetError } = await import('../server/workBudget.ts')
const { withArgsCanvases } = await import('../server/toolLoads.ts')
const { execTool, newRunState } = await import('../server/resident.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

/* The workspace library through the canvas write entry (server/canvasWrites.ts): taking a
   published component up, pulling its updates, the tokens it brings, and "update everywhere",
   one write per canvas. Same contract as every command: a failure only ever a rejection, which
   undoes the operation awaiting it. */

const OWNER = 'owner-1'
const user: Actor = { name: 'Ada', kind: 'user', color: '#2743ee' }
const agent: Actor = { name: 'Doop', kind: 'agent', color: '#000' }
const chip = { name: 'Chip', html: '<span class="chip">Chip</span>', css: '.chip { color: var(--brand) }' }
let sent: ServerMessage[]
let workspaces = 0
let workspaceId: string
let libraryId: string
let consumerId: string

function workspaceCanvas(name: string) {
  const canvas = store.createCanvas(name, OWNER)
  store.setWorkspace(canvas.id, workspaceId)
  return canvas.id
}

beforeEach(() => {
  for (const canvas of store.allCanvases()) {
    unpublishLibrary(canvas.id)
    store.canvases.delete(canvas.id)
  }
  workspaceId = `ws-${++workspaces}`
  sent = []
  actions.wire(
    (_canvasId, message) => void sent.push(message),
    () => {},
  )
  /* a library publishing a Chip that names its --brand token */
  libraryId = workspaceCanvas('Design system')
  actions.createTokens(libraryId, [{ name: '--brand', type: 'color', value: '#0177d3' }], user)
  createComponentFromHtml(libraryId, chip, user)
  publishToLibrary(libraryId, undefined, user, OWNER)
  consumerId = workspaceCanvas('Landing')
  sent = []
})

afterEach(() => {
  vi.restoreAllMocks()
  idle.fail = undefined
})

const componentsOn = (canvasId: string) => (store.getCanvas(canvasId)!.components ?? []).map((def) => def.name)
const tokensOn = (canvasId: string) => store.getTokens(canvasId).map((token) => token.name)
const chipOn = (canvasId: string) => store.getComponents(canvasId).find((def) => def.name === 'Chip')

let edition = 0
/** The library moves its Chip on and publishes again: every canvas using it has an update
 *  waiting. Answers the text the Chip now shows. */
function publishNewChip() {
  const text = `Chip ${++edition}`
  updateComponent(libraryId, 'Chip', { html: `<span class="chip">${text}</span>` }, user)
  publishToLibrary(libraryId, undefined, user, OWNER)
  return text
}

/** The store refuses to create tokens, as storage might. */
const refuseTokens = () =>
  vi.spyOn(store, 'setTokens').mockImplementation(() => {
    throw new Error('storage refused')
  })

describe('before the entry is wired', () => {
  it('still carries the tokens of a component a frame write took up, saying it bypassed the entry', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    actions.createFrame(consumerId, { name: 'Hero', html: '<main><doop-use component="Chip"></doop-use></main>' }, user)
    expect(componentsOn(consumerId)).toEqual(['Chip'])
    expect(tokensOn(consumerId)).toEqual(['--brand'])
    expect(String(logged.mock.calls[0]?.[0])).toContain('outside the canvas write entry')
  })
})

describe('the workspace library through the canvas write entry', () => {
  /* the take-in hook, the idle settler and the token carrier, as the server wires them at boot */
  beforeAll(() => wireCanvasWrites())

  it('answers each command with what its action answers, and a view only when asked', async () => {
    const imported = await runCanvasWrite(consumerId, {
      type: 'import-component',
      from: libraryId,
      component: 'Chip',
      actor: user,
    })
    expect(imported.component).toMatchObject({ name: 'Chip', source: { canvasId: libraryId, library: true } })
    expect(imported.view).toBeUndefined()
    /* the token its CSS names came along */
    expect(tokensOn(consumerId)).toEqual(['--brand'])

    const edited = publishNewChip()
    const synced = await runCanvasWrite(consumerId, {
      type: 'sync-component',
      component: 'Chip',
      readable: [],
      actor: user,
      view: true,
    })
    expect(synced.updated).toBe(true)
    expect(synced.component.template).toContain(edited)
    expect(synced.view?.entry).toMatchObject({ name: 'Chip' })

    /* nothing waiting any more */
    expect(
      await runCanvasWrite(consumerId, { type: 'sync-library-updates', readable: [], actor: user, view: true }),
    ).toMatchObject({
      waiting: 0,
      updated: [],
      frames: [],
    })
    publishNewChip()
    const all = await runCanvasWrite(consumerId, { type: 'sync-library-updates', readable: [], actor: user })
    expect(all.waiting).toBe(1)
    expect(all.updated.map((def) => def.name)).toEqual(['Chip'])
    expect(all).not.toHaveProperty('frames')

    publishNewChip()
    const pulled = await runCanvasWrite(consumerId, { type: 'pull-library', library: libraryId, actor: user })
    expect(pulled.update).toMatchObject({ canvas_id: consumerId, updated: ['Chip'] })
    expect(pulled.refusal).toBeUndefined()

    /* a pull commits nothing by itself: undone with the operation that sent it */
    const before = chipOn(consumerId)!.rev
    publishNewChip()
    const request = openTransaction()
    await request.run(() => runCanvasWrite(consumerId, { type: 'pull-library', library: libraryId, actor: user }))
    expect(chipOn(consumerId)!.rev).toBeGreaterThan(before)
    request.rollback()
    expect(chipOn(consumerId)!.rev).toBe(before)

    /* a refusal rejects, as the action threw it */
    await expect(
      runCanvasWrite(consumerId, { type: 'import-component', from: libraryId, component: 'Nobody', actor: user }),
    ).rejects.toThrow('does not publish')
  })

  it('carries the tokens of a component a frame write took up, through the entry, once the write lands', async () => {
    const frame = actions.createFrame(
      consumerId,
      { name: 'Hero', html: '<main><doop-use component="Chip"></doop-use></main>' },
      user,
    )!
    expect(componentsOn(consumerId)).toEqual(['Chip'])
    expect(tokensOn(consumerId)).toEqual(['--brand'])

    /* a carry that fails is logged by the entry's carrier, and takes nothing of the frame back */
    const other = workspaceCanvas('Pricing')
    const refused = refuseTokens()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const second = actions.createFrame(
      other,
      { name: 'Hero', html: '<main><doop-use component="Chip"></doop-use></main>' },
      user,
    )!
    await Promise.resolve()
    refused.mockRestore()
    expect(String(logged.mock.calls[0]?.[0])).toContain('could not carry the tokens')
    expect(store.getFrame(second.id)?.html).toContain('data-doop-instance')
    expect(tokensOn(other)).toEqual([])
    expect(store.getFrame(frame.id)).toBeDefined()

    /* carried by hand, it answers the tokens it created */
    const carried = await runCanvasWrite(other, {
      type: 'carry-library-tokens',
      components: [chipOn(other)!.id],
      actor: user,
    })
    expect(carried).toEqual([{ name: '--brand', result: 'created' }])
    expect(tokensOn(other)).toEqual(['--brand'])
  })

  it('a rejected library command inside a request is undone, earlier writes too, and tells nobody', async () => {
    const refused = refuseTokens()
    const request = openTransaction()
    await expect(
      request.run(async () => {
        await runCanvasWrite(consumerId, { type: 'set-token-themes', themes: ['dark'], actor: user })
        /* the Chip is saved, then carrying its token fails: the command and the themes go */
        await runCanvasWrite(consumerId, { type: 'import-component', from: libraryId, component: 'Chip', actor: user })
      }),
    ).rejects.toThrow('storage refused')
    request.rollback()
    refused.mockRestore()
    expect(store.getTokenThemes(consumerId)).toEqual([])
    expect(componentsOn(consumerId)).toEqual([])
    expect(sent).toEqual([])
  })

  it('a rejected library command inside an MCP tool call is undone, earlier writes too, and tells nobody', async () => {
    await runCanvasWrite(consumerId, { type: 'import-component', from: libraryId, component: 'Chip', actor: agent })
    const before = chipOn(consumerId)!.rev
    publishNewChip()
    sent = []
    const refused = vi.spyOn(store, 'saveComponent').mockImplementation(() => {
      throw new Error('storage refused')
    })
    await expect(
      withArgsCanvases(
        {},
        async () => {
          await runCanvasWrite(consumerId, { type: 'set-token-themes', themes: ['dark'], actor: agent })
          await runCanvasWrite(consumerId, { type: 'sync-component', component: 'Chip', readable: [], actor: agent })
        },
        'sync_component',
      ),
    ).rejects.toThrow('storage refused')
    refused.mockRestore()
    expect(store.getTokenThemes(consumerId)).toEqual([])
    expect(chipOn(consumerId)!.rev).toBe(before)
    expect(sent).toEqual([])
  })

  it('a rejected library command inside a resident tool call answers an error, is undone, and tells nobody', async () => {
    const refused = refuseTokens()
    const result = await execTool(
      {
        type: 'tool_use',
        id: 't1',
        name: 'import_component',
        input: { source_canvas_id: libraryId, component: 'Chip' },
      },
      consumerId,
      actions.resolveActor({ name: roleName(DEFAULT_ROLE_ID), kind: 'agent' }),
      newRunState(),
    )
    refused.mockRestore()
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('storage refused')
    /* the Chip was saved before its token failed: it went with the call */
    expect(componentsOn(consumerId)).toEqual([])
    expect(sent).toEqual([])
  })
})

describe('update everywhere, one write per canvas', () => {
  const options = { canEdit: () => true, canRead: () => true, publisherId: OWNER }
  const budget = () => new WorkBudgetError('update everywhere', undefined, 'time')
  let secondId: string
  let thirdId: string
  let edited: string

  beforeAll(() => wireCanvasWrites())

  beforeEach(async () => {
    secondId = workspaceCanvas('Pricing')
    thirdId = workspaceCanvas('About')
    for (const id of [consumerId, secondId, thirdId])
      await runCanvasWrite(id, { type: 'import-component', from: libraryId, component: 'Chip', actor: user })
    edited = publishNewChip()
    sent = []
  })

  const everywhere = () =>
    runOperation('update everywhere', libraryId, () => updateLibraryConsumers(libraryId, user, options))

  /** The store refuses component saves on one canvas with `error`, as storage or a budget might. */
  const refuseSavesOn = (canvasId: string, error: () => Error = () => new Error('storage refused')) => {
    const save = store.saveComponent.bind(store)
    return vi.spyOn(store, 'saveComponent').mockImplementation((id, ...rest) => {
      if (id === canvasId) throw error()
      return save(id, ...rest)
    })
  }

  it('pulls into every canvas using the library', async () => {
    const report = await everywhere()
    expect(report.canvases.map((entry) => entry.canvas_id)).toEqual([consumerId, secondId, thirdId])
    expect(report.skipped).toEqual([])
    for (const id of [consumerId, secondId, thirdId]) expect(chipOn(id)!.template).toContain(edited)
  })

  it('says how far it got when a pull runs out of budget after an earlier one was committed', async () => {
    const before = chipOn(secondId)!.rev
    const refused = refuseSavesOn(secondId, budget)
    const report = await everywhere()
    refused.mockRestore()
    expect(report.canvases.map((entry) => entry.canvas_id)).toEqual([consumerId])
    expect(report.skipped).toEqual([
      {
        canvas_id: secondId,
        canvas_name: 'Pricing',
        reason: 'failed',
        message:
          'the update stopped here, and nothing was changed on this canvas: this update ran out of its work budget; run it again to continue',
      },
      expect.objectContaining({ canvas_id: thirdId, reason: 'not_reached' }),
    ])
    expect(chipOn(consumerId)!.template).toContain(edited)
    expect(chipOn(secondId)!.rev).toBe(before)
    expect(chipOn(thirdId)!.template).not.toContain(edited)
  })

  it('covers a canvas’s whole step: its load fails after a commit, and a canvas gone since is not listed', async () => {
    const load = store.load.bind(store)
    vi.spyOn(store, 'load').mockImplementation(async (id, ...rest) => {
      if (id !== secondId) return load(id, ...rest)
      /* the third leaves meanwhile */
      store.canvases.delete(thirdId)
      throw budget()
    })
    const report = await everywhere()
    expect(report.canvases.map((entry) => entry.canvas_id)).toEqual([consumerId])
    expect(report.skipped).toEqual([expect.objectContaining({ canvas_id: secondId, reason: 'failed' })])
  })

  it('counts a committed pull as done even before its frames are counted', async () => {
    /* the first canvas's pull is committed, then the wait for its frames is refused */
    idle.fail = (canvasId) => (canvasId === consumerId ? budget() : undefined)
    const report = await everywhere()
    expect(report.canvases).toEqual([])
    expect(report.skipped).toEqual([
      expect.objectContaining({
        canvas_id: consumerId,
        reason: 'failed',
        message: expect.stringContaining('the update was applied here'),
      }),
      expect.objectContaining({ canvas_id: secondId, reason: 'not_reached' }),
      expect.objectContaining({ canvas_id: thirdId, reason: 'not_reached' }),
    ])
    expect(chipOn(consumerId)!.template).toContain(edited)
    expect(chipOn(secondId)!.template).not.toContain(edited)
  })

  it('fails, logging it, on anything that is not a refusal, even after a commit; what was committed stays', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const refused = refuseSavesOn(secondId)
    await expect(everywhere()).rejects.toThrow('storage refused')
    refused.mockRestore()
    expect(logged.mock.calls.some((call) => call[1] instanceof Error)).toBe(true)
    expect(chipOn(consumerId)!.template).toContain(edited)
    expect(chipOn(secondId)!.template).not.toContain(edited)
  })

  it('fails whole, its operation undone, when the first canvas fails before any pull was committed', async () => {
    const before = chipOn(consumerId)!.rev
    const refused = refuseSavesOn(consumerId, budget)
    await expect(everywhere()).rejects.toBeInstanceOf(WorkBudgetError)
    refused.mockRestore()
    expect(chipOn(consumerId)!.rev).toBe(before)
    expect(chipOn(secondId)!.template).not.toContain(edited)
  })
})
