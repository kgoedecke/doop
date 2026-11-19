import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
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
const { updateComponent } = await import('../server/componentActions.ts')
const { COMPONENT_ATTR } = await import('../shared/components.ts')
const { transaction } = await import('../server/journal.ts')
const { runOperation, WorkBudgetError } = await import('../server/workBudget.ts')
const { withArgsCanvases } = await import('../server/toolLoads.ts')
const { execTool } = await import('../server/resident.ts')
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
  actions.wire(
    (_canvasId, message) => void sent.push(message),
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
      {
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
      },
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
