import { Actor, Emittable, Persisted, type ActorSocketOf } from 'durable-actors'
import type { ActivityItem, Actor as Attribution, Frame } from '../shared/types.js'
import { repairEscapedHtml } from '../server/escapedHtml.js'
import { MAX_FRAME_HTML_BYTES } from '../server/limits.js'

export type FrameInput = Pick<Frame, 'name'> & Partial<Pick<Frame, 'x' | 'y' | 'width' | 'height' | 'html' | 'demo'>>
export type FramePatch = Partial<Pick<Frame, 'name' | 'x' | 'y' | 'width' | 'height' | 'html'>>
export type FrameWrite =
  | { type: 'create'; id?: string; input: FrameInput }
  | { type: 'update'; id: string; patch: FramePatch }
  | { type: 'append'; id: string; chunk: string; start: boolean; done?: boolean }
  | { type: 'delete'; id: string }

export type FrameSnapshot = {
  type: 'snapshot'
  revision: number
  frames: Frame[]
  initialized: boolean
  deleted: boolean
  activity: ActivityItem[]
}
export type FrameChange = {
  type: 'change'
  revision: number
  operation: FrameWrite['type']
  frame: Frame
  actor: Attribution
  requestId?: string
  activity?: ActivityItem
  streaming?: boolean
}

export type FrameCommand = { type: 'write'; requestId: string; write: FrameWrite } | { type: 'snapshot' }
export type FrameMetadata = { actor: Attribution; readOnly: boolean }
export type FrameMessage = FrameSnapshot | { type: 'error'; requestId: string; message: string }

/** One writer for a canvas's frames. Accounts, canvas metadata and AI stay in Doop. */
export class CanvasFrames extends Actor<FrameMetadata, FrameCommand, FrameMessage> {
  @Persisted private frames: Frame[] = []
  @Persisted private revision = 0
  @Persisted private initialized = false
  @Persisted private deleted = false
  @Persisted private activity: ActivityItem[] = []
  // Emitted by the runtime after persistence. broadcast()/send() are live output,
  // so they must not be used as an acknowledgment of a durable frame edit.
  @Persisted @Emittable committed: FrameChange | FrameSnapshot | null = null

  override async onConnect(socket: ActorSocketOf<CanvasFrames>) {
    socket.send(await this.snapshot())
  }

  override async onMessage(socket: ActorSocketOf<CanvasFrames>, command: FrameCommand) {
    if (command.type === 'snapshot') return socket.send(await this.snapshot())
    try {
      if (socket.metadata.readOnly) throw new Error('This connection is read only')
      const change = await this.write(command.write, socket.metadata.actor, command.requestId)
      if (!change) throw new Error('Canvas or frame not found')
    } catch (error) {
      socket.send({
        type: 'error',
        requestId: command.requestId,
        message: error instanceof Error ? error.message : 'Frame edit failed',
      })
    }
  }

  async initialize(frames: Frame[]): Promise<FrameSnapshot> {
    if (!this.initialized) {
      if (frames.some((frame) => frame.canvasId !== this.id)) throw new Error('Canvas ID mismatch')
      this.frames = frames
      this.initialized = true
    }
    return this.snapshot()
  }

  async snapshot(): Promise<FrameSnapshot> {
    return {
      type: 'snapshot',
      revision: this.revision,
      frames: this.frames,
      initialized: this.initialized,
      deleted: this.deleted,
      activity: this.activity,
    }
  }

  async write(write: FrameWrite, by: Attribution, requestId?: string): Promise<FrameChange | null> {
    if (!this.initialized || this.deleted) return null
    const id = write.type === 'create' ? (write.id ?? `${this.id}.${crypto.randomUUID()}`) : write.id
    let frame = this.frames.find((frame) => frame.id === id)
    const before = frame
    const input = write.type === 'create' ? write.input : write.type === 'update' ? write.patch : undefined
    if (input) {
      for (const key of ['x', 'y', 'width', 'height'] as const)
        if (
          input[key] !== undefined &&
          (!Number.isFinite(input[key]) || ((key === 'width' || key === 'height') && input[key]! <= 0))
        )
          throw new Error(`Invalid frame ${key}`)
      if (input.html !== undefined) input.html = repairEscapedHtml(input.html)
    }
    const html = write.type === 'append' ? (write.start ? '' : (frame?.html ?? '')) + write.chunk : input?.html
    if (html !== undefined && new TextEncoder().encode(html).length > MAX_FRAME_HTML_BYTES)
      throw new Error('Frame HTML is too large')
    const now = Math.max(Date.now(), ...this.frames.map((frame) => frame.updatedAt + 1))
    if (write.type === 'create') {
      if (frame) throw new Error('Frame already exists')
      if (!id.startsWith(`${this.id}.`)) throw new Error('New frame IDs must belong to this canvas')
      const input = write.input
      frame = {
        id,
        canvasId: this.id,
        name: input.name,
        x: input.x ?? (this.frames.length ? Math.max(...this.frames.map((frame) => frame.x + frame.width)) + 80 : 120),
        y: input.y ?? 120,
        width: input.width ?? 640,
        height: input.height ?? 480,
        html: input.html ?? '',
        createdAt: now,
        updatedAt: now,
        updatedBy: by.name,
        ...(input.demo ? { demo: true } : {}),
      }
      this.frames = [...this.frames, frame]
    } else {
      if (!frame) return null
      if (write.type === 'delete') this.frames = this.frames.filter((frame) => frame.id !== write.id)
      else {
        const patch =
          write.type === 'append'
            ? { html: (write.start ? '' : frame.html) + write.chunk }
            : Object.fromEntries(
                Object.entries(write.patch).filter(([key]) =>
                  ['name', 'x', 'y', 'width', 'height', 'html'].includes(key),
                ),
              )
        frame = { ...frame, ...patch, updatedAt: now, updatedBy: by.name }
        this.frames = this.frames.map((previous) => (previous.id === frame!.id ? frame! : previous))
      }
    }
    const change: FrameChange = {
      type: 'change',
      revision: ++this.revision,
      operation: write.type,
      frame,
      actor: by,
      ...(write.type === 'append' ? { streaming: !write.done } : {}),
      ...(requestId ? { requestId } : {}),
    }
    if (requestId) {
      const message =
        write.type === 'create'
          ? `created frame “${frame.name}”`
          : write.type === 'delete'
            ? `deleted frame “${frame.name}”`
            : frame.html !== before?.html
              ? `updated the design of “${frame.name}”`
              : frame.name !== before?.name
                ? `renamed “${before?.name}” to “${frame.name}”`
                : undefined
      if (message) {
        change.activity = {
          id: requestId,
          actorName: by.name,
          actorKind: by.kind,
          actorColor: by.color,
          message,
          frameId: frame.id,
          at: now,
        }
        this.activity = [change.activity, ...this.activity].slice(0, 100)
      }
    }
    this.committed = change
    return change
  }

  async destroy(): Promise<void> {
    this.deleted = true
    this.initialized = true
    this.frames = []
    this.revision++
    this.committed = await this.snapshot()
  }
}
