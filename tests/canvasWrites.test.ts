import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { FrameRunner } from '../server/propagation.ts'
import type { Actor, Frame, ServerMessage } from '../shared/types'

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
  saveFeedback: () => {},
  saveComment: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))
vi.mock('../server/fonts.ts', () => ({ fontsForCanvas: () => [] }))
const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const {
  CanvasMismatchError,
  FRAME_CHANGED,
  FrameVersionConflict,
  runCanvasWrite,
  settleIdleStreams,
  settleRetriesPending,
  wireCanvasWrites,
} = await import('../server/canvasWrites.ts')
const { newInlineData } = await import('../server/inlineData.ts')
const { blankComponent } = await import('../server/components.ts')
const { ComponentError, createComponentFromHtml, updateComponent } = await import('../server/componentActions.ts')
const { COMPONENT_ATTR } = await import('../shared/components.ts')
const { openTransaction, transaction } = await import('../server/journal.ts')
const { runOperation, usage, WorkBudgetError } = await import('../server/workBudget.ts')
const { withArgsCanvases } = await import('../server/toolLoads.ts')
const propagation = await import('../server/propagation.ts')
const { execTool, newRunState } = await import('../server/resident.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

/* The canvas write entry (server/canvasWrites.ts) and its local host: the server's own
   actions. Its contract: always a promise, a failure only ever its rejection, and every
   kind of operation that awaits it undone by that rejection as by a thrown error. */

/* the take-in hook and the idle settler, as the server wires them at boot */
wireCanvasWrites()

const user: Actor = { name: 'Ada', kind: 'user', color: '#2743ee' }
const agent: Actor = { name: 'Doop', kind: 'agent', color: '#000' }
let sent: ServerMessage[]
let canvasId: string

beforeEach(() => {
  sent = []
  /* a test hears only the canvases it makes. An earlier test's canvas can still be talking:
     an agent's frame plays back as a reveal for seconds after it is made (actions.ts ticks
     every 80 ms), so on a slow run a tick lands inside a later test's window */
  const earlier = new Set(store.allCanvases().map((canvas) => canvas.id))
  actions.wire(
    (room, message) => void (earlier.has(room) || sent.push(message)),
    () => {},
  )
  canvasId = store.createCanvas('writes', 'ada').id
})

const types = () => sent.map((message) => message.type)
const doc = (body: string) =>
  `<!doctype html><html><head><title>Writes</title></head><body><main>${body}</main></body></html>`

/** The store refuses the next frame write, as storage or a work budget might. */
const refuseNextWrite = () =>
  vi.spyOn(store, 'updateFrame').mockImplementationOnce(() => {
    throw new Error('storage refused')
  })

describe('the canvas write entry, on its local host', () => {
  it('answers each command with what its action answers', async () => {
    const created = await runCanvasWrite(canvasId, { type: 'create-frame', input: { name: 'A' }, actor: user })
    expect(created).toMatchObject({ name: 'A', canvasId })
    const id = created!.id

    const written = await runCanvasWrite(canvasId, {
      type: 'write-frame',
      frameId: id,
      patch: { html: '<main><p>one</p></main>' },
      actor: user,
    })
    expect(written?.html).toContain('<p>one</p>')
    expect(await runCanvasWrite(canvasId, { type: 'write-frame', frameId: 'gone', patch: {}, actor: user })).toBe(
      undefined,
    )

    const edited = await runCanvasWrite(canvasId, {
      type: 'edit-frame-html',
      frameId: id,
      find: '<p>one</p>',
      replace: '<p>two</p>',
      actor: agent,
      inline: 'mcp',
    })
    expect(edited.ok && edited.frame.html).toContain('<p>two</p>')
    expect(
      await runCanvasWrite(canvasId, {
        type: 'edit-frame-html',
        frameId: id,
        find: '<p>missing</p>',
        replace: '',
        actor: agent,
        inline: 'mcp',
      }),
    ).toEqual({ ok: false, problem: { problem: 'not_found' } })
    expect(
      await runCanvasWrite(canvasId, {
        type: 'edit-frame-html',
        frameId: 'gone',
        find: 'a',
        replace: 'b',
        actor: agent,
        inline: 'mcp',
      }),
    ).toEqual({ ok: false, missing: true })
    const inline = await runCanvasWrite(canvasId, {
      type: 'edit-frame-html',
      frameId: id,
      find: '<p>two</p>',
      replace: `<img src="data:image/png;base64,${'A'.repeat(64)}">`,
      actor: agent,
      inline: 'resident',
    })
    expect(inline.ok).toBe(false)
    expect('inline' in inline && inline.inline).toEqual(expect.any(String))
    expect(store.getFrame(id)?.html).toContain('<p>two</p>')

    expect(await runCanvasWrite(canvasId, { type: 'frame-meta', frameId: id, patch: {}, actor: agent })).toEqual({
      ok: false,
      error: 'nothing to update',
    })
    const moved = await runCanvasWrite(canvasId, { type: 'frame-meta', frameId: id, patch: { x: 40 }, actor: agent })
    expect(moved.ok && moved.value.x).toBe(40)
    expect(
      await runCanvasWrite('no-such-canvas', { type: 'frame-meta', frameId: 'gone', patch: { x: 1 }, actor: agent }),
    ).toEqual({ ok: false, error: 'canvas not found' })

    expect(
      await runCanvasWrite(canvasId, { type: 'restack-frames', frames: [{ id, z: 3 }], actor: user }),
    ).toMatchObject([{ id, z: 3 }])

    const approved = await runCanvasWrite(canvasId, {
      type: 'set-approval',
      frameId: id,
      ready: true,
      user: { id: 'u1', name: 'Ada' },
    })
    expect(approved?.approval).toMatchObject({ status: 'ready_for_dev', approvedBy: 'Ada' })
    expect(
      await runCanvasWrite(canvasId, {
        type: 'agent-approval',
        frameId: 'gone',
        status: 'draft',
        user: { id: 'u1', name: 'Ada' },
        actor: agent,
      }),
    ).toEqual({ ok: false, error: 'no frame with id gone' })

    expect(await runCanvasWrite(canvasId, { type: 'delete-frame', frameId: id, actor: user })).toMatchObject({ id })
    expect(store.getFrame(id)).toBeUndefined()
  })

  it('reports a failure only by rejecting, never by throwing from the call', async () => {
    const frame = actions.createFrame(canvasId, { name: 'Kept' }, user)!
    const fails = refuseNextWrite()
    let answer: Promise<unknown> | undefined
    expect(() => {
      answer = runCanvasWrite(canvasId, { type: 'write-frame', frameId: frame.id, patch: { name: 'x' }, actor: user })
    }).not.toThrow()
    await expect(answer).rejects.toThrow('storage refused')
    fails.mockRestore()
    expect(store.getFrame(frame.id)?.name).toBe('Kept')
  })

  it('writes when it is called, before its answer is awaited', () => {
    const frame = actions.createFrame(canvasId, { name: 'Now' }, user)!
    const answer = runCanvasWrite(canvasId, {
      type: 'write-frame',
      frameId: frame.id,
      patch: { name: 'Renamed' },
      actor: user,
    })
    expect(store.getFrame(frame.id)?.name).toBe('Renamed')
    expect(answer).toBeInstanceOf(Promise)
  })

  it('refuses a frame of another canvas than the one it is sent for, and writes nothing', async () => {
    const elsewhere = actions.createFrame(store.createCanvas('other', 'ada').id, { name: 'Other' }, user)!
    sent = []
    for (const command of [
      { type: 'write-frame', frameId: elsewhere.id, patch: { name: 'x' }, actor: user },
      { type: 'delete-frame', frameId: elsewhere.id, actor: user },
      { type: 'frame-meta', frameId: elsewhere.id, patch: { x: 1 }, actor: user },
    ] as const)
      await expect(runCanvasWrite(canvasId, command)).rejects.toBeInstanceOf(CanvasMismatchError)
    expect(store.getFrame(elsewhere.id)).toMatchObject({ name: 'Other', x: elsewhere.x })
    expect(sent).toEqual([])
  })

  it('writes a version-checked command only while the frame is at that version', async () => {
    const frame = actions.createFrame(canvasId, { name: 'Checked' }, user)!
    const version = frame.updatedAt
    actions.updateFrame(frame.id, { name: 'Moved on' }, user)
    sent = []
    for (const command of [
      { type: 'write-frame', frameId: frame.id, patch: { name: 'stale' }, actor: user, ifUpdatedAt: version },
      { type: 'delete-frame', frameId: frame.id, actor: user, ifUpdatedAt: version },
      { type: 'set-approval', frameId: frame.id, ready: true, user: { id: 'u1', name: 'Ada' }, ifUpdatedAt: version },
    ] as const) {
      const refused = await runCanvasWrite(canvasId, command).catch((error: unknown) => error)
      expect(refused).toBeInstanceOf(FrameVersionConflict)
      /* what REST answers with, as `requireFrame` always did */
      expect((refused as InstanceType<typeof FrameVersionConflict>).message).toBe(FRAME_CHANGED)
      expect((refused as InstanceType<typeof FrameVersionConflict>).frame).toBe(store.getFrame(frame.id))
    }
    expect(store.getFrame(frame.id)).toMatchObject({ name: 'Moved on' })
    expect(store.getFrame(frame.id)?.approval).toBeUndefined()
    expect(sent).toEqual([])
    const current = store.getFrame(frame.id)!.updatedAt
    expect(
      await runCanvasWrite(canvasId, {
        type: 'write-frame',
        frameId: frame.id,
        patch: { name: 'Fresh' },
        actor: user,
        ifUpdatedAt: current,
      }),
    ).toMatchObject({ name: 'Fresh' })
  })

  it('sends what an operation wrote after it commits, in the order the actions sent it before', async () => {
    /* each on a canvas of its own, so the second finds only the frames it made */
    const run = async (write: (name: string) => Promise<void> | void) => {
      canvasId = store.createCanvas('order', 'ada').id
      sent = []
      await transaction(async () => {
        await write('First')
        await write('Second')
        expect(sent).toEqual([])
      })
      return types()
    }
    const direct = await run((name) => {
      const frame = actions.createFrame(canvasId, { name }, user)!
      actions.updateFrame(frame.id, { html: `<p>${name}</p>` }, user)
    })
    const routed = await run(async (name) => {
      const frame = await runCanvasWrite(canvasId, { type: 'create-frame', input: { name }, actor: user })
      await runCanvasWrite(canvasId, {
        type: 'write-frame',
        frameId: frame!.id,
        patch: { html: `<p>${name}</p>` },
        actor: user,
      })
    })
    expect(routed).toEqual(direct)
    expect(routed.length).toBeGreaterThan(0)
  })

  it('hands back the promise of a command whose action awaits', async () => {
    const frame = actions.createFrame(canvasId, { name: 'Versioned', html: '<main><p>a</p></main>' }, user)!
    const restore = runCanvasWrite(canvasId, {
      type: 'restore-version',
      frameId: frame.id,
      versionId: 'no-such-version',
      actor: user,
    })
    expect(restore).toBeInstanceOf(Promise)
    /* the version is read from the database, which has none: null, as the action answers */
    await expect(restore).resolves.toBe(null)
  })
})

describe('a rejected canvas write inside each kind of operation', () => {
  it('a plain operation (as a request runs in) is undone and tells nobody', async () => {
    const fails = refuseNextWrite()
    let created: string | undefined
    await expect(
      runOperation('test', canvasId, async () => {
        created = (await runCanvasWrite(canvasId, { type: 'create-frame', input: { name: 'Undone' }, actor: user }))!.id
        await runCanvasWrite(canvasId, { type: 'write-frame', frameId: created, patch: { name: 'x' }, actor: user })
      }),
    ).rejects.toThrow('storage refused')
    fails.mockRestore()
    expect(store.getFrame(created!)).toBeUndefined()
    expect(sent).toEqual([])
  })

  it('an MCP tool call is undone and tells nobody', async () => {
    const fails = refuseNextWrite()
    let created: string | undefined
    /* the wrapper every MCP tool runs in (server/toolLoads.ts), with what a tool does */
    await expect(
      withArgsCanvases(
        {},
        async () => {
          created = (await runCanvasWrite(canvasId, {
            type: 'create-frame',
            input: { name: 'From a tool' },
            actor: agent,
          }))!.id
          await runCanvasWrite(canvasId, { type: 'write-frame', frameId: created, patch: { name: 'x' }, actor: agent })
        },
        'create_frame',
      ),
    ).rejects.toThrow('storage refused')
    fails.mockRestore()
    expect(store.getFrame(created!)).toBeUndefined()
    expect(sent).toEqual([])
  })

  it('a resident tool call answers an error, is undone and tells nobody', async () => {
    const frame = actions.createFrame(canvasId, { name: 'Home', html: doc('<p>before</p>') }, user)!
    sent = []
    const fails = refuseNextWrite()
    const result = await execTool(
      { type: 'tool_use', id: 't1', name: 'set_frame_html', input: { frame_id: frame.id, html: doc('<p>after</p>') } },
      canvasId,
      actions.resolveActor({ name: roleName(DEFAULT_ROLE_ID), kind: 'agent' }),
      newRunState(),
    )
    fails.mockRestore()
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('storage refused')
    expect(store.getFrame(frame.id)?.html).toContain('<p>before</p>')
    expect(sent).toEqual([])
  })
})

describe('streams through the canvas write entry', () => {
  const base64 = (chars: number) => 'QUJD'.repeat(Math.ceil(chars / 4)).slice(0, chars)

  it('appends a chunk, and answers a frame that is gone as missing', async () => {
    const frame = actions.createFrame(canvasId, { name: 'Streamed' }, agent)!
    const first = await runCanvasWrite(canvasId, {
      type: 'append-frame-html',
      frameId: frame.id,
      chunk: '<!doctype html><html><head></head><body><p>one</p>',
      actor: agent,
      start: true,
      inline: 'mcp',
    })
    expect(first.ok && first.frame.html).toContain('<p>one</p>')
    expect(actions.isFrameMidStream(frame.id)).toBe(true)
    const last = await runCanvasWrite(canvasId, {
      type: 'append-frame-html',
      frameId: frame.id,
      chunk: '<p>two</p></body></html>',
      actor: agent,
      done: true,
    })
    expect(last.ok && last.frame.html).toContain('<p>two</p>')
    expect(actions.isFrameMidStream(frame.id)).toBe(false)
    expect(
      await runCanvasWrite(canvasId, { type: 'append-frame-html', frameId: 'gone', chunk: 'x', actor: agent }),
    ).toEqual({ ok: false, missing: true })
  })

  it('refuses a chunk that adds inline data, in the words the MCP tool used, and writes nothing', async () => {
    const frame = actions.createFrame(canvasId, { name: 'Inline' }, agent)!
    const html = '<!doctype html><html><head></head><body>'
    await runCanvasWrite(canvasId, {
      type: 'append-frame-html',
      frameId: frame.id,
      chunk: html,
      actor: agent,
      start: true,
      inline: 'mcp',
    })
    const whole = await runCanvasWrite(canvasId, {
      type: 'append-frame-html',
      frameId: frame.id,
      chunk: `<img src="data:image/png;base64,${base64(64)}">`,
      actor: agent,
      inline: 'mcp',
    })
    expect(!whole.ok && 'inline' in whole && whole.inline).toMatch(/^Refused, nothing was written:/)
    /* a block of base64 sent in two chunks, each too short to be one: the second completes it */
    const half = base64(3000)
    expect(
      (
        await runCanvasWrite(canvasId, {
          type: 'append-frame-html',
          frameId: frame.id,
          chunk: `<script>const a = "${half}`,
          actor: agent,
          inline: 'mcp',
        })
      ).ok,
    ).toBe(true)
    const completing = await runCanvasWrite(canvasId, {
      type: 'append-frame-html',
      frameId: frame.id,
      chunk: `${half}"</script>`,
      actor: agent,
      inline: 'mcp',
    })
    expect(!completing.ok && 'inline' in completing && completing.inline).toMatch(
      /^Refused, this chunk was not written:[\s\S]*Begin the frame again \(start=true\)/,
    )
    expect(store.getFrame(frame.id)?.html).not.toContain(`${half}"`)
    /* the same chunk from a writer that is not checked (a person, the demo) is written */
    expect(
      (
        await runCanvasWrite(canvasId, {
          type: 'append-frame-html',
          frameId: frame.id,
          chunk: `<img src="data:image/png;base64,${base64(64)}">`,
          actor: user,
        })
      ).ok,
    ).toBe(true)
  })

  it('checks a whole frame by each surface’s rule, only for commands that ask', async () => {
    const uri = `data:image/png;base64,${base64(64)}`
    const refused = await runCanvasWrite(canvasId, {
      type: 'create-frame',
      input: { name: 'Agent', html: doc(`<img src="${uri}">`) },
      actor: agent,
      inline: 'resident',
    })
    expect(refused).toMatchObject({
      ok: false,
      inline: expect.stringMatching(/^Refused, nothing was written:/),
    })
    expect(store.getCanvas(canvasId)!.frames.some((frame) => frame.name === 'Agent')).toBe(false)
    /* a person's frame is not checked */
    const kept = await runCanvasWrite(canvasId, {
      type: 'create-frame',
      input: { name: 'Person', html: doc(`<img src="${uri}">`) },
      actor: user,
    })
    expect(kept?.html).toContain(uri)
    /* a rewrite may carry over what the frame holds, on either surface */
    for (const surface of ['mcp', 'resident'] as const) {
      const carried = await runCanvasWrite(canvasId, {
        type: 'write-frame',
        frameId: kept!.id,
        patch: { html: doc(`<p>${surface}</p><img src="${uri}">`) },
        actor: agent,
        inline: surface,
      })
      expect(carried && 'inline' in carried).toBe(false)
    }
    const added = await runCanvasWrite(canvasId, {
      type: 'write-frame',
      frameId: kept!.id,
      patch: { html: doc(`<img src="data:image/gif;base64,${base64(64)}">`) },
      actor: agent,
      inline: 'mcp',
    })
    expect(added).toMatchObject({ ok: false, inline: expect.any(String) })
    /* a frame that is not there is checked as holding nothing, never skipped */
    expect(
      await runCanvasWrite(canvasId, {
        type: 'write-frame',
        frameId: 'gone',
        patch: { html: doc(`<img src="${uri}">`) },
        actor: agent,
        inline: 'mcp',
      }),
    ).toMatchObject({ ok: false, inline: expect.any(String) })
    expect(store.getFrame(kept!.id)?.html).toContain('<p>resident</p>')
  })

  it('reads what a frame holds only once a candidate is found, and then once', () => {
    let reads = 0
    const held = () => {
      reads++
      return ''
    }
    expect(newInlineData('<p>nothing here</p>', held)).toEqual([])
    expect(reads).toBe(0)
    newInlineData(`<img src="data:image/png;base64,QUJD"><img src="data:image/gif;base64,REVG">`, held)
    expect(reads).toBe(1)
  })

  it('a rejected chunk is undone inside its operation, opens no stream and tells nobody', async () => {
    const frame = actions.createFrame(canvasId, { name: 'Refused', html: doc('<p>before</p>') }, agent)!
    sent = []
    const fails = refuseNextWrite()
    await expect(
      runOperation('mcp append_frame_html', canvasId, () =>
        runCanvasWrite(canvasId, {
          type: 'append-frame-html',
          frameId: frame.id,
          chunk: '<!doctype html><html><body><p>after',
          actor: agent,
          start: true,
          inline: 'mcp',
        }),
      ),
    ).rejects.toThrow('storage refused')
    fails.mockRestore()
    expect(store.getFrame(frame.id)?.html).toContain('<p>before</p>')
    expect(actions.isFrameMidStream(frame.id)).toBe(false)
    expect(sent).toEqual([])
  })

  it('settles an idle stream through the entry, and closes one whose settling is refused', async () => {
    const settledFrame = actions.createFrame(canvasId, { name: 'Idle' }, agent)!
    actions.appendFrameHtml(settledFrame.id, '<!doctype html><html><head></head><body><p>half', agent, { start: true })
    sent = []
    await settleIdleStreams(Date.now() + 60_000)
    expect(actions.isFrameMidStream(settledFrame.id)).toBe(false)
    expect(types()).toContain('frame:streaming')

    /* a stream that is behind its component, so that settling it rewrites the frame */
    const def = blankComponent({ name: 'Pill', by: 'Tester', props: [] })
    store.saveComponent(canvasId, def)
    const main = actions.createFrame(canvasId, { name: 'Pill main', html: '' }, user)!
    actions.updateFrame(main.id, { html: doc(`<div class="pill" ${COMPONENT_ATTR}="${def.id}">Old</div>`) }, user)
    const refusedFrame = actions.createFrame(canvasId, { name: 'Too heavy' }, agent)!
    actions.appendFrameHtml(refusedFrame.id, doc(`<doop-use component="${def.id}"></doop-use>`), agent, {
      start: true,
    })
    updateComponent(canvasId, def.id, { html: `<div class="pill">Fresh</div>` }, user)
    const html = store.getFrame(refusedFrame.id)!.html
    expect(html).not.toContain('Fresh')
    const refuses = vi.spyOn(store, 'updateFrame').mockImplementationOnce(() => {
      throw new WorkBudgetError('settle', canvasId, 'bytes')
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await settleIdleStreams(Date.now() + 60_000)
    const refusedOnce = refuses.mock.calls.length
    refuses.mockRestore()
    logged.mockRestore()
    expect(refusedOnce).toBeGreaterThan(0)
    /* the settling was undone, the stream closed all the same */
    expect(actions.isFrameMidStream(refusedFrame.id)).toBe(false)
    expect(store.getFrame(refusedFrame.id)?.html).toBe(html)
  })
})

describe('settling idle streams', () => {
  /** A stream whose settling rewrites its frame: it uses a component that changed since. */
  function streamBehindItsComponent(name: string) {
    const def = blankComponent({ name, by: 'Tester', props: [] })
    store.saveComponent(canvasId, def)
    const main = actions.createFrame(canvasId, { name: `${name} main`, html: '' }, user)!
    actions.updateFrame(main.id, { html: doc(`<div class="pill" ${COMPONENT_ATTR}="${def.id}">Old</div>`) }, user)
    const frame = actions.createFrame(canvasId, { name: `${name} page` }, agent)!
    actions.appendFrameHtml(frame.id, doc(`<doop-use component="${def.id}"></doop-use>`), agent, { start: true })
    updateComponent(canvasId, def.id, { html: `<div class="pill">Fresh</div>` }, user)
    return frame
  }

  it('leaves open a stream that receives a chunk while an earlier one settles', async () => {
    const first = actions.createFrame(canvasId, { name: 'First' }, agent)!
    const second = actions.createFrame(canvasId, { name: 'Second' }, agent)!
    for (const frame of [first, second])
      actions.appendFrameHtml(frame.id, '<!doctype html><html><head></head><body><p>half', agent, { start: true })
    /* the chunk below must not share a millisecond with the streams' last activity */
    await new Promise((resolve) => setTimeout(resolve, 5))
    const pass = settleIdleStreams(Date.now() + 60_000)
    /* the first is settled by now (the local host writes when called); the pass awaits it */
    expect(actions.isFrameMidStream(first.id)).toBe(false)
    actions.appendFrameHtml(second.id, '<p>more</p>', agent)
    await pass
    expect(actions.isFrameMidStream(second.id)).toBe(true)
    expect(store.getFrame(second.id)?.html).toContain('<p>more</p>')
  })

  it('retries a failing settle after 1 s and 5 s, then closes the stream, saying so', async () => {
    const frame = streamBehindItsComponent('Failing')
    const html = store.getFrame(frame.id)!.html
    const fails = vi.spyOn(store, 'updateFrame').mockImplementation(() => {
      throw new Error('storage refused')
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    /* the clock alone is faked: settling sets no timer of its own */
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 })
    const pass = async (advance: number) => {
      vi.setSystemTime(Date.now() + advance)
      await settleIdleStreams()
    }
    const tries = () => fails.mock.calls.length
    try {
      await pass(0)
      const once = tries()
      expect(once).toBeGreaterThan(0)
      await pass(999) /* too soon: not tried */
      expect(tries()).toBe(once)
      await pass(1)
      const twice = tries()
      expect(twice).toBeGreaterThan(once)
      expect(actions.isFrameMidStream(frame.id)).toBe(true)
      await pass(4_999) /* too soon */
      expect(tries()).toBe(twice)
      await pass(1)
      expect(tries()).toBeGreaterThan(twice)
    } finally {
      vi.useRealTimers()
      fails.mockRestore()
    }
    const lines = logged.mock.calls.map((call) => String(call[0]))
    logged.mockRestore()
    expect(actions.isFrameMidStream(frame.id)).toBe(false)
    expect(store.getFrame(frame.id)?.html).toBe(html)
    /* the error once, with its stack, and the close */
    expect(lines.filter((line) => line.includes('settling the stream of frame'))).toHaveLength(1)
    expect(lines.filter((line) => line.includes('closed the stream of frame'))).toHaveLength(1)
    expect(settleRetriesPending()).toBe(0)
  })

  it('forgets a failed settle once its stream has closed another way', async () => {
    const frame = streamBehindItsComponent('Forgotten')
    const fails = vi.spyOn(store, 'updateFrame').mockImplementationOnce(() => {
      throw new Error('storage refused')
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await settleIdleStreams(Date.now() + 60_000)
    fails.mockRestore()
    logged.mockRestore()
    expect(settleRetriesPending()).toBe(1)
    /* the agent sends its last chunk after all */
    actions.appendFrameHtml(frame.id, '</body></html>', agent, { done: true })
    expect(actions.isFrameMidStream(frame.id)).toBe(false)
    await settleIdleStreams(Date.now() + 60_000)
    expect(settleRetriesPending()).toBe(0)
  })

  it('never rejects: a throw while closing, or anywhere in a pass, is logged, and the next pass runs', async () => {
    const frame = streamBehindItsComponent('Throwing')
    const refuses = vi.spyOn(store, 'updateFrame').mockImplementationOnce(() => {
      throw new WorkBudgetError('settle', canvasId, 'bytes')
    })
    /* the log line after a close throws: the close's own guard catches it */
    const logged = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      if (String(line).includes('closed the stream of frame')) throw new Error('the log broke')
    })
    await expect(settleIdleStreams(Date.now() + 60_000)).resolves.toBeUndefined()
    refuses.mockRestore()
    expect(actions.isFrameMidStream(frame.id)).toBe(false)
    expect(logged.mock.calls.some(([line]) => String(line).includes('could not close'))).toBe(true)

    /* a throw outside the close (here the budget line itself): the pass's guard catches it */
    const other = streamBehindItsComponent('Throwing again')
    const refusesAgain = vi.spyOn(store, 'updateFrame').mockImplementationOnce(() => {
      throw new WorkBudgetError('settle', canvasId, 'bytes')
    })
    logged.mockImplementation((line: unknown) => {
      if (String(line).startsWith('[streams] ') && String(line).includes('was stopped'))
        throw new Error('the log broke')
    })
    await expect(settleIdleStreams(Date.now() + 60_000)).resolves.toBeUndefined()
    refusesAgain.mockRestore()
    expect(logged.mock.calls.some(([line]) => String(line).includes('settling idle streams failed'))).toBe(true)
    logged.mockRestore()

    /* and the next pass runs, and settles */
    expect(actions.isFrameMidStream(other.id)).toBe(true)
    await settleIdleStreams(Date.now() + 60_000)
    expect(actions.isFrameMidStream(other.id)).toBe(false)
  })

  it('answers an inline refusal, by type, exactly when the command may carry inline', () => {
    const appendUnchecked = () =>
      runCanvasWrite('c', { type: 'append-frame-html', frameId: 'f', chunk: '', actor: user })
    expectTypeOf<Awaited<ReturnType<typeof appendUnchecked>>>().toEqualTypeOf<
      { ok: true; frame: Frame } | { ok: false; missing: true }
    >()
    const surface = undefined as 'mcp' | 'resident' | undefined
    const appendMaybe = () =>
      runCanvasWrite('c', { type: 'append-frame-html', frameId: 'f', chunk: '', actor: user, inline: surface })
    expectTypeOf<Awaited<ReturnType<typeof appendMaybe>>>().toEqualTypeOf<
      { ok: true; frame: Frame } | { ok: false; missing: true } | { ok: false; inline: string }
    >()
    const createUnchecked = () => runCanvasWrite('c', { type: 'create-frame', input: { name: 'x' }, actor: user })
    expectTypeOf<Awaited<ReturnType<typeof createUnchecked>>>().toEqualTypeOf<Frame | undefined>()
  })
})

describe('design tokens through the canvas write entry', () => {
  const ink = { name: '--color-ink', type: 'color', value: '#111111' }
  const names = () => store.getTokens(canvasId).map((token) => token.name)
  /** The store refuses the next token write, as storage or a work budget might. */
  const refuseNextTokens = () =>
    vi.spyOn(store, 'setTokens').mockImplementationOnce(() => {
      throw new Error('storage refused')
    })

  it('answers each token command with what its action answers', async () => {
    const created = await runCanvasWrite(canvasId, { type: 'create-tokens', tokens: [ink], actor: user })
    expect(created?.results).toMatchObject([{ name: '--color-ink', result: 'created' }])
    /* the tokens this write left, read with it: not whatever a later write leaves */
    expect(created?.tokens.map((token) => token.name)).toEqual(['--color-ink'])
    const renamed = await runCanvasWrite(canvasId, {
      type: 'set-tokens',
      edits: [{ name: '--color-ink', newName: '--color-text' }],
      actor: user,
    })
    expect(renamed?.results[0]).toMatchObject({ name: '--color-text' })
    expect(renamed?.tokens.map((token) => token.name)).toEqual(['--color-text'])
    expect(names()).toEqual(['--color-text'])
    expect(await runCanvasWrite(canvasId, { type: 'set-token-themes', themes: ['dark'], actor: user })).toMatchObject({
      themes: ['dark'],
      tokens: [{ name: '--color-text' }],
    })
    expect(await runCanvasWrite('no-such-canvas', { type: 'create-tokens', tokens: [ink], actor: user })).toBe(
      undefined,
    )
    /* a bad list is refused by rejecting with TokenThemesError, as the action threw, with
       nothing written */
    const refused = runCanvasWrite(canvasId, { type: 'set-token-themes', themes: 'dark', actor: user })
    await expect(refused).rejects.toBeInstanceOf(actions.TokenThemesError)
    await expect(refused).rejects.toThrow('themes must be an array of names')
    expect(store.getTokenThemes(canvasId)).toEqual(['dark'])
  })

  it('a set-tokens rename revises the components naming the token, and an undone one leaves them', async () => {
    await runCanvasWrite(canvasId, { type: 'create-tokens', tokens: [ink], actor: user })
    const { component } = createComponentFromHtml(
      canvasId,
      { name: 'Chip', html: '<span class="chip">Chip</span>', css: '.chip { color: var(--color-ink) }' },
      user,
    )
    const rename = () =>
      runCanvasWrite(canvasId, {
        type: 'set-tokens',
        edits: [{ name: '--color-ink', newName: '--color-text' }],
        actor: user,
      })
    const chip = () => store.getComponents(canvasId).find((def) => def.id === component.id)!
    /* undone with the request that made it: the definition is as it was */
    const request = openTransaction()
    await request.run(rename)
    request.rollback()
    expect(names()).toEqual(['--color-ink'])
    expect(chip().rev).toBe(component.rev)
    expect(chip().css).toContain('var(--color-ink)')
    sent = []
    await rename()
    expect(chip().rev).toBe(component.rev + 1)
    expect(chip().css).toContain('var(--color-text)')
    /* the room hears the revision, and the tokens */
    expect(types()).toEqual(expect.arrayContaining(['component', 'tokens']))
  })

  it('a rejected token command inside a request is undone, and tells nobody', async () => {
    const fails = refuseNextTokens()
    /* what the HTTP middleware and undoRequest do with a request (server/index.ts) */
    const request = openTransaction()
    await expect(
      request.run(async () => {
        await runCanvasWrite(canvasId, { type: 'set-token-themes', themes: ['dark'], actor: user })
        await runCanvasWrite(canvasId, { type: 'create-tokens', tokens: [ink], actor: user })
      }),
    ).rejects.toThrow('storage refused')
    request.rollback()
    fails.mockRestore()
    expect(store.getTokenThemes(canvasId)).toEqual([])
    expect(names()).toEqual([])
    expect(sent).toEqual([])
  })

  it('a rejected token command inside an MCP tool call is undone, and tells nobody', async () => {
    const fails = refuseNextTokens()
    await expect(
      withArgsCanvases(
        {},
        async () => {
          await runCanvasWrite(canvasId, { type: 'set-token-themes', themes: ['dark'], actor: agent })
          await runCanvasWrite(canvasId, { type: 'create-tokens', tokens: [ink], actor: agent })
        },
        'create_tokens',
      ),
    ).rejects.toThrow('storage refused')
    fails.mockRestore()
    expect(store.getTokenThemes(canvasId)).toEqual([])
    expect(names()).toEqual([])
    expect(sent).toEqual([])
  })

  const resident = () => actions.resolveActor({ name: roleName(DEFAULT_ROLE_ID), kind: 'agent' })

  it('a rejected token command inside a resident tool call answers an error, is undone, and tells nobody', async () => {
    const fails = refuseNextTokens()
    /* a token with a value for a theme the canvas lacks: the theme is declared first, then the
       token write is refused, and the tool call's operation undoes the theme too */
    const result = await execTool(
      {
        type: 'tool_use',
        id: 't1',
        name: 'create_tokens',
        input: { tokens: [{ ...ink, themes: { dark: '#eeeeee' } }] },
      },
      canvasId,
      resident(),
      newRunState(),
    )
    expect(fails).toHaveBeenCalled()
    fails.mockRestore()
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('storage refused')
    expect(store.getTokenThemes(canvasId)).toEqual([])
    expect(names()).toEqual([])
    expect(sent).toEqual([])
  })

  it('answers a refused theme list in the tool’s words, and fails the tool call on anything else', async () => {
    const refused = await execTool(
      { type: 'tool_use', id: 't1', name: 'set_token_themes', input: { themes: 'dark' } },
      canvasId,
      resident(),
      newRunState(),
    )
    expect(refused).toMatchObject({ is_error: true, content: 'themes must be an array of names' })
    /* storage failing is not a refusal of the list: the tool call fails, and is undone */
    const fails = vi.spyOn(store, 'setTokenThemes').mockImplementationOnce(() => {
      throw new Error('storage refused')
    })
    const failed = await execTool(
      { type: 'tool_use', id: 't2', name: 'set_token_themes', input: { themes: ['dark'] } },
      canvasId,
      resident(),
      newRunState(),
    )
    fails.mockRestore()
    expect(failed.is_error).toBe(true)
    expect(String(failed.content)).toContain('storage refused')
    expect(store.getTokenThemes(canvasId)).toEqual([])
    expect(sent).toEqual([])
  })
})

describe('component definitions through the canvas write entry', () => {
  const chip = { name: 'Chip', html: '<span class="chip">Chip</span>', css: '.chip { color: red }' }
  const componentNames = () => (store.getCanvas(canvasId)!.components ?? []).map((def) => def.name)
  /** The store refuses the `nth` component save from now on, as storage might. */
  const refuseComponentSave = (nth: number) => {
    let saves = 0
    const save = store.saveComponent.bind(store)
    return vi.spyOn(store, 'saveComponent').mockImplementation((...args) => {
      saves += 1
      if (saves === nth) throw new Error('storage refused')
      return save(...args)
    })
  }

  it('answers each command with what its action answers, and what the write left', async () => {
    const created = await runCanvasWrite(canvasId, {
      type: 'create-component',
      from: { kind: 'html', ...chip },
      actor: user,
      view: true,
    })
    expect(created.component).toMatchObject({ name: 'Chip' })
    expect(created.view?.entry).toMatchObject({ name: 'Chip' })
    expect(created.view?.frames.map((frame) => frame.id)).toEqual([created.component.mainFrameId])

    const batch = await runCanvasWrite(canvasId, {
      type: 'create-components',
      entries: [
        { name: 'Badge', html: '<b class="badge">New</b>' },
        { name: 'Card', html: '<div class="card"><doop-use component="Nowhere"></doop-use></div>' },
      ],
      actor: user,
    })
    expect(batch.map((entry) => entry.ok)).toEqual([true, false])
    expect(batch[1]).toMatchObject({ ok: false, name: 'Card', error: expect.stringContaining('Nowhere') })
    expect(componentNames()).toEqual(['Chip', 'Badge'])

    const updated = await runCanvasWrite(canvasId, {
      type: 'update-component',
      component: 'Chip',
      input: { find: '>Chip<', replace: '>Chip!<' },
      actor: user,
    })
    expect(updated.component.rev).toBe(created.component.rev + 1)
    /* not asked for: none built */
    expect(updated.view).toBeUndefined()

    const restored = await runCanvasWrite(canvasId, {
      type: 'restore-component-version',
      component: 'Chip',
      rev: created.component.rev,
      actor: user,
    })
    expect(restored.component.template).toContain('>Chip<')

    expect(await runCanvasWrite(canvasId, { type: 'delete-component', component: 'Badge', actor: user })).toMatchObject(
      { deleted: 'Badge' },
    )
    const back = await runCanvasWrite(canvasId, { type: 'restore-component', component: 'Badge', actor: user })
    expect(back.component).toMatchObject({ name: 'Badge' })

    /* a refusal rejects, as the action threw it */
    await expect(
      runCanvasWrite(canvasId, { type: 'update-component', component: 'Nobody', input: {}, actor: user }),
    ).rejects.toBeInstanceOf(ComponentError)
  })

  it('costs a request what calling the action did: no view is built unless asked', async () => {
    /* what a write parses, in an operation of its own, on a canvas of its own */
    const parsed = async (write: () => Promise<unknown> | unknown) => {
      canvasId = store.createCanvas('cost', 'ada').id
      let bytes = 0
      await runOperation('cost', canvasId, async () => {
        await write()
        bytes = usage().parsedBytes
      })
      return bytes
    }
    const update = { find: '>Chip<', replace: '>Chip!<' }
    /* main's REST path: the actions, called directly */
    const direct = await parsed(() => {
      createComponentFromHtml(canvasId, chip, user)
      updateComponent(canvasId, 'Chip', update, user)
    })
    const routed = await parsed(async () => {
      await runCanvasWrite(canvasId, { type: 'create-component', from: { kind: 'html', ...chip }, actor: user })
      await runCanvasWrite(canvasId, { type: 'update-component', component: 'Chip', input: update, actor: user })
    })
    expect(direct).toBeGreaterThan(0)
    expect(routed).toBe(direct)
  })

  it('a rejected component command inside a request is undone, earlier writes too, and tells nobody', async () => {
    const fails = refuseComponentSave(1)
    const request = openTransaction()
    await expect(
      request.run(async () => {
        await runCanvasWrite(canvasId, { type: 'set-token-themes', themes: ['dark'], actor: user })
        await runCanvasWrite(canvasId, { type: 'create-component', from: { kind: 'html', ...chip }, actor: user })
      }),
    ).rejects.toThrow('storage refused')
    request.rollback()
    fails.mockRestore()
    expect(store.getTokenThemes(canvasId)).toEqual([])
    expect(componentNames()).toEqual([])
    expect(store.getCanvas(canvasId)!.frames).toEqual([])
    expect(sent).toEqual([])
  })

  it('a rejected component command inside an MCP tool call is undone, earlier writes too, and tells nobody', async () => {
    const fails = refuseComponentSave(1)
    await expect(
      withArgsCanvases(
        {},
        async () => {
          await runCanvasWrite(canvasId, { type: 'set-token-themes', themes: ['dark'], actor: agent })
          await runCanvasWrite(canvasId, { type: 'create-component', from: { kind: 'html', ...chip }, actor: agent })
        },
        'create_component',
      ),
    ).rejects.toThrow('storage refused')
    fails.mockRestore()
    expect(store.getTokenThemes(canvasId)).toEqual([])
    expect(componentNames()).toEqual([])
    expect(sent).toEqual([])
  })

  it('a rejected component command inside a resident tool call answers an error, is undone, and tells nobody', async () => {
    /* the second entry's save fails: the first, already made, goes with the tool call */
    const first = refuseComponentSave(99)
    await runCanvasWrite(canvasId, { type: 'create-component', from: { kind: 'html', ...chip }, actor: agent })
    const savesPerComponent = first.mock.calls.length
    first.mockRestore()
    canvasId = store.createCanvas('writes', 'ada').id
    sent = []
    const fails = refuseComponentSave(savesPerComponent + 1)
    const result = await execTool(
      {
        type: 'tool_use',
        id: 't1',
        name: 'create_components',
        input: { components: [chip, { name: 'Badge', html: '<b class="badge">New</b>' }] },
      },
      canvasId,
      actions.resolveActor({ name: roleName(DEFAULT_ROLE_ID), kind: 'agent' }),
      newRunState(),
    )
    expect(fails.mock.calls.length).toBeGreaterThan(savesPerComponent)
    fails.mockRestore()
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('storage refused')
    expect(componentNames()).toEqual([])
    expect(store.getCanvas(canvasId)!.frames).toEqual([])
    expect(sent).toEqual([])
  })
})

describe('instances through the canvas write entry', () => {
  /** A component, and a frame to place it in, without anything said to the room. */
  async function setup() {
    const made = await runCanvasWrite(canvasId, {
      type: 'create-component',
      from: { kind: 'html', name: 'Chip', html: '<span class="chip">Chip</span>' },
      actor: user,
    })
    const page = actions.createFrame(canvasId, { name: 'Page', html: doc('<p>page</p>') }, user)!
    sent = []
    return { component: made.component, page }
  }

  it('places and changes instances, answering what the write left', async () => {
    const { page } = await setup()
    const placed = await runCanvasWrite(canvasId, {
      type: 'insert-instance',
      input: { frameId: page.id, component: 'Chip', props: {} },
      actor: user,
    })
    expect(placed.instanceId).not.toBe('')
    expect(placed.frame.html).toContain('data-doop-instance=')
    const changed = await runCanvasWrite(canvasId, {
      type: 'change-instances',
      frameId: page.id,
      changes: [{ instanceId: placed.instanceId, detach: true }],
      actor: user,
      view: true,
    })
    expect(changed.missing).toEqual([])
    expect(changed.instances).toEqual([])
    /* not asked for: not read */
    const again = await runCanvasWrite(canvasId, {
      type: 'change-instances',
      frameId: page.id,
      changes: [],
      actor: user,
    })
    expect(again.instances).toBeUndefined()
  })

  it('a rejected instance command inside a request is undone, earlier writes too, and tells nobody', async () => {
    const { page } = await setup()
    const html = store.getFrame(page.id)!.html
    const fails = refuseNextWrite()
    const request = openTransaction()
    await expect(
      request.run(async () => {
        await runCanvasWrite(canvasId, { type: 'set-token-themes', themes: ['dark'], actor: user })
        await runCanvasWrite(canvasId, {
          type: 'insert-instance',
          input: { frameId: page.id, component: 'Chip' },
          actor: user,
        })
      }),
    ).rejects.toThrow('storage refused')
    request.rollback()
    fails.mockRestore()
    expect(store.getTokenThemes(canvasId)).toEqual([])
    expect(store.getFrame(page.id)!.html).toBe(html)
    expect(sent).toEqual([])
  })

  it('a rejected instance command inside an MCP tool call is undone, earlier writes too, and tells nobody', async () => {
    const { page } = await setup()
    const html = store.getFrame(page.id)!.html
    const fails = refuseNextWrite()
    await expect(
      withArgsCanvases(
        {},
        async () => {
          await runCanvasWrite(canvasId, { type: 'set-token-themes', themes: ['dark'], actor: agent })
          await runCanvasWrite(canvasId, {
            type: 'insert-instance',
            input: { frameId: page.id, component: 'Chip' },
            actor: agent,
          })
        },
        'insert_instance',
      ),
    ).rejects.toThrow('storage refused')
    fails.mockRestore()
    expect(store.getTokenThemes(canvasId)).toEqual([])
    expect(store.getFrame(page.id)!.html).toBe(html)
    expect(sent).toEqual([])
  })

  it('a rejected instance command inside a resident tool call answers an error, is undone, and tells nobody', async () => {
    const { page } = await setup()
    /* one instance placed and kept, then one change of two refused: the call undoes it all */
    const placed = await runCanvasWrite(canvasId, {
      type: 'insert-instance',
      input: { frameId: page.id, component: 'Chip' },
      actor: user,
    })
    const html = store.getFrame(page.id)!.html
    sent = []
    const fails = refuseNextWrite()
    const result = await execTool(
      {
        type: 'tool_use',
        id: 't1',
        name: 'update_instances',
        input: { frame_id: page.id, instances: [{ instance_id: placed.instanceId, detach: true }] },
      },
      canvasId,
      actions.resolveActor({ name: roleName(DEFAULT_ROLE_ID), kind: 'agent' }),
      newRunState(),
    )
    fails.mockRestore()
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('storage refused')
    expect(store.getFrame(page.id)!.html).toBe(html)
    expect(sent).toEqual([])
  })
})

describe('the background queue through the canvas write entry', () => {
  /* a turn's refusal is a spy on the store: a test that fails or times out before it restores
     its spies must not refuse the next test's writes too */
  afterEach(() => vi.restoreAllMocks())
  /** A component and `count` pages each holding one instance of it, the queue drained. */
  async function chips(count: number) {
    await runCanvasWrite(canvasId, {
      type: 'create-component',
      from: { kind: 'html', name: 'Chip', html: '<span class="chip">Chip</span>' },
      actor: user,
    })
    const pages = Array.from({ length: count }, (_, n) =>
      actions.createFrame(canvasId, { name: `Page ${n}`, html: doc(`<p>page ${n}</p>`) }, user)!,
    )
    for (const page of pages)
      await runCanvasWrite(canvasId, {
        type: 'insert-instance',
        input: { frameId: page.id, component: 'Chip' },
        actor: user,
      })
    await propagation.whenIdle()
    sent = []
    return pages
  }
  /** The first frame write the queue makes throws `error`, before anything is written. */
  function refuseFirstQueuedWrite(error: Error) {
    let thrown = false
    const fail = () => {
      if (thrown) return
      thrown = true
      throw error
    }
    const update = store.updateFrame.bind(store)
    const rerender = store.rerenderFrame.bind(store)
    const spies = [
      vi.spyOn(store, 'updateFrame').mockImplementation((...args: Parameters<typeof store.updateFrame>) => {
        fail()
        return update(...args)
      }),
      vi.spyOn(store, 'rerenderFrame').mockImplementation((...args: Parameters<typeof store.rerenderFrame>) => {
        fail()
        return rerender(...args)
      }),
    ]
    return () => spies.forEach((spy) => spy.mockRestore())
  }
  const updatedFrames = () => sent.flatMap((message) => (message.type === 'frame:updated' ? [message.frame.id] : []))
  const holdsChip = (frameId: string, chip: string) => store.getFrame(frameId)!.html.includes(chip)

  for (const [kind, error] of [
    ['a spent work budget', new WorkBudgetError('queue propagate', 'canvas', 'bytes')],
    ['a refused write', new Error('storage refused')],
  ] as const) {
    it(`renders every frame again but the one whose turn hits ${kind}, which is undone and tells nobody`, async () => {
      const pages = await chips(3)
      await runCanvasWrite(canvasId, {
        type: 'update-component',
        component: 'Chip',
        input: { find: 'class="chip"', replace: 'class="chip big"' },
        actor: user,
      })
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const restore = refuseFirstQueuedWrite(error)
      await propagation.whenIdle()
      restore()
      const fresh = pages.filter((page) => holdsChip(page.id, 'chip big'))
      const stale = pages.filter((page) => !holdsChip(page.id, 'chip big'))
      expect(fresh).toHaveLength(2)
      expect(stale).toHaveLength(1)
      /* the room hears of the frames brought up, and nothing of the one undone */
      expect(updatedFrames()).not.toContain(stale[0]!.id)
      for (const page of fresh) expect(updatedFrames()).toContain(page.id)
      /* said and skipped, as the queue always did, and never rejected */
      expect(logged.mock.calls.some(([line]) => String(line).includes(`frame ${stale[0]!.id}`))).toBe(true)
      logged.mockRestore()
    })
  }

  it('detaches every frame but the one whose write is refused, which keeps its instance', async () => {
    const pages = await chips(3)
    const detach = await runCanvasWrite(canvasId, {
      type: 'detach-instances',
      component: 'Chip',
      actor: user,
      frames: true,
    })
    /* what was queued, and the frames it will rewrite, read in the write's own step */
    expect(detach).toMatchObject({ queued: true, instances: 3, frames: 3 })
    const ids = pages.map((page) => page.id).sort()
    expect([...detach.frameIds].sort()).toEqual(ids)
    expect(detach.touched!.map((frame) => frame.id).sort()).toEqual(ids)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const restore = refuseFirstQueuedWrite(new Error('storage refused'))
    await propagation.whenIdle()
    restore()
    logged.mockRestore()
    const kept = pages.filter((page) => holdsChip(page.id, 'data-doop-instance='))
    expect(kept).toHaveLength(1)
    expect(updatedFrames()).not.toContain(kept[0]!.id)
    expect(updatedFrames()).toHaveLength(2)
    const line = actions.getActivity(canvasId).find((item) => item.message.startsWith('detached'))
    expect(line?.message).toContain('detached 2 instances')
  })

  it('reads the frames a detach rewrites only when asked', async () => {
    await chips(2)
    const detach = await runCanvasWrite(canvasId, { type: 'detach-instances', component: 'Chip', actor: user })
    expect(detach.frameIds).toHaveLength(2)
    expect(detach.touched).toBeUndefined()
    await propagation.whenIdle()
  })

  it("lets other canvases go on while one canvas's turn goes unanswered, and says that turn failed", async () => {
    const hungCanvas = canvasId
    const hungPages = await chips(2)
    canvasId = store.createCanvas('other', 'ada').id
    const pages = await chips(2)
    const timeout = propagation.setTurnTimeout(200)
    const routed: FrameRunner | undefined = propagation.routeFrameTask('propagate', (...turn) =>
      turn[0] === hungCanvas ? new Promise(() => {}) : routed!(...turn),
    )
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const id of [hungCanvas, canvasId])
        await runCanvasWrite(id, {
          type: 'update-component',
          component: 'Chip',
          input: { find: 'class="chip"', replace: 'class="chip big"' },
          actor: user,
        })
      await propagation.whenCanvasIdle(canvasId)
      for (const page of pages) expect(holdsChip(page.id, 'chip big')).toBe(true)
      for (const page of hungPages) expect(holdsChip(page.id, 'chip big')).toBe(false)
      /* each of the hung canvas's turns is said as failed when it times out, and the canvas goes on */
      await propagation.whenIdle()
      const timedOut = logged.mock.calls.filter(([, , error]) => String(error).includes('no answer within 0.2 s'))
      expect(timedOut).toHaveLength(2)
    } finally {
      propagation.routeFrameTask('propagate', routed!)
      propagation.setTurnTimeout(timeout)
      logged.mockRestore()
    }
  })

  it('keeps nothing of a turn whose canvas was deleted while it was in flight', async () => {
    await chips(2)
    const doomed = canvasId
    let turns = 0
    const routed: FrameRunner | undefined = propagation.routeFrameTask('propagate', async (...turn) => {
      const outcome = await routed!(...turn)
      /* the last frame's turn: the one whose answer would close the job and report it */
      turns += 1
      if (turns === 2) transaction(() => store.deleteCanvas(doomed))
      return outcome
    })
    let reported: Awaited<ReturnType<typeof propagation.whenCanvasIdle>> | undefined
    try {
      await runCanvasWrite(doomed, {
        type: 'update-component',
        component: 'Chip',
        input: { find: 'class="chip"', replace: 'class="chip big"' },
        actor: user,
      })
      sent = []
      reported = await propagation.whenCanvasIdle(doomed)
      await propagation.whenIdle()
    } finally {
      propagation.routeFrameTask('propagate', routed!)
    }
    expect(turns).toBe(2)
    expect(reported.propagate).toBeUndefined()
    expect(store.getCanvas(doomed)).toBeUndefined()
    expect(propagation.pendingFrames(doomed)).toBe(0)
    /* no "updated … in N frames" line, and nothing else said, for a canvas that is gone */
    expect(sent.filter((message) => message.type === 'activity')).toEqual([])
  })

  it('queues nothing for a detach whose request is undone', async () => {
    const pages = await chips(2)
    const request = openTransaction()
    await expect(
      request.run(async () => {
        await runCanvasWrite(canvasId, { type: 'detach-instances', component: 'Chip', actor: user })
        throw new Error('a later step failed')
      }),
    ).rejects.toThrow('a later step failed')
    request.rollback()
    await propagation.whenIdle()
    expect(propagation.pendingFrames(canvasId)).toBe(0)
    for (const page of pages) expect(holdsChip(page.id, 'data-doop-instance=')).toBe(true)
    expect(sent).toEqual([])
  })
})
