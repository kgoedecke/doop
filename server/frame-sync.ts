import WebSocket from 'ws'
import { actors, type SocketGrant } from '../generated/actors/index.js'
import { env } from './env.ts'
import { issueFrameTicket, postgresCanvas, type FrameConnection, type FrameSocketMessage } from './postgresCanvas.ts'
import type { CanvasCommand, SocketMetadata } from '../src/actor.ts'

/* say why, instead of failing on the first canvas a flagged owner opens */
if (env.NODE_ENV === 'production' && env.DOOP_CANVAS_ACTORS !== 'off' && !env.TERSE_ACTOR_URL) {
  throw new Error(
    'TERSE_ACTOR_URL is required in production unless DOOP_CANVAS_ACTORS=off. Configure a separately hosted actor API with a public WebSocket endpoint.',
  )
}

/**
 * Where one canvas's pages and frames live. A canvas on actors has its own
 * Terse `CanvasActor`; every other canvas has the Postgres stand-in
 * (server/postgresCanvas.ts), with the same methods and socket protocol. The
 * store decides per canvas (`store.frameStoreOf`) and registers that here.
 */
export type FrameStore = 'actor' | 'postgres'

export function setFrameStoreResolver(resolver: (canvasId: string) => Promise<FrameStore>) {
  resolveStore = resolver
}

/** The canvas's pages and frames, wherever they live: each method finds out
 *  where (once per canvas and process) and calls it there. */
export function canvasActor(canvasId: string): CanvasStub {
  const stub: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  for (const method of Object.keys(STUB_METHODS)) {
    stub[method] = async (...args) => {
      const target = await canvasTarget(canvasId)
      const call = Reflect.get(target, method) as (...values: unknown[]) => Promise<unknown>
      return call.apply(target, args)
    }
  }
  return stub as CanvasStub
}

/** A browser's socket for one canvas: its actor's, or this server's
 *  /ws/frames with a one-time ticket. `origin` is the ws(s) origin the
 *  browser reached this server on. */
export async function prepareCanvasSocket(
  authorization: { actorId: string; metadata: SocketMetadata },
  origin: string,
): Promise<SocketGrant> {
  if ((await resolveStore(authorization.actorId)) === 'actor') return actors.CanvasActor.prepareWebsocket(authorization)
  const { ticket, expiresAt } = issueFrameTicket(authorization.actorId, authorization.metadata)
  return { websocketUrl: `${origin}/ws/frames?ticket=${ticket}`, homeRegion: 'local', connectByMs: expiresAt }
}

/** This server's own subscription to a canvas (the room's frame feed). */
export interface FrameSocket {
  readonly open: boolean
  send(command: CanvasCommand): void
  close(): void
  onMessage(listener: (message: unknown) => void): void
  onClose(listener: () => void): void
}

export async function openCanvasSocket(canvasId: string, metadata: SocketMetadata): Promise<FrameSocket> {
  if ((await resolveStore(canvasId)) === 'actor') {
    const grant = await actors.CanvasActor.prepareWebsocket({ actorId: canvasId, metadata })
    return new ActorSocket(new WebSocket(grant.websocketUrl))
  }
  return new LocalSocket(canvasId, metadata)
}

/** Bound activation and payload pressure when reading many canvases. */
export async function mapFrames<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await read(items[index]!)
      }
    }),
  )
  return results
}

type CanvasStub = actors.CanvasActor.Stub

/** Every method of the actor's stub; a method added to the actor fails the type check here until listed. */
const STUB_METHODS: { [Method in keyof CanvasStub]: true } = {
  accessVersion: true,
  addPage: true,
  createFrame: true,
  deleteFrame: true,
  destroy: true,
  frame: true,
  getVersion: true,
  importFrames: true,
  initialize: true,
  listVersions: true,
  pageOf: true,
  restack: true,
  revokeAccess: true,
  setFlowStart: true,
  setPageBackground: true,
  setPages: true,
  snapshot: true,
  summary: true,
  write: true,
}

/* Until the store registers, follow the deployment's setting alone. */
let resolveStore = async (_canvasId: string): Promise<FrameStore> =>
  env.DOOP_CANVAS_ACTORS === 'all' ? 'actor' : 'postgres'

async function canvasTarget(canvasId: string): Promise<CanvasStub> {
  return (await resolveStore(canvasId)) === 'actor' ? actors.CanvasActor.get(canvasId) : postgresCanvas(canvasId)
}

/** A canvas actor's socket, as the server reads it. */
class ActorSocket implements FrameSocket {
  constructor(private readonly socket: WebSocket) {
    socket.on('error', () => socket.close())
  }

  get open() {
    return this.socket.readyState === WebSocket.OPEN
  }

  send(command: CanvasCommand) {
    this.socket.send(JSON.stringify(command))
  }

  close() {
    this.socket.close()
  }

  onMessage(listener: (message: unknown) => void) {
    this.socket.on('message', (data) => listener(JSON.parse(String(data))))
  }

  onClose(listener: () => void) {
    this.socket.on('close', listener)
  }
}

/** A subscription to a Postgres canvas inside this process. Deliveries are
 *  queued, as they would be over a network, so neither side re-enters the
 *  other; messages wait for the first listener, so none is missed. */
class LocalSocket implements FrameSocket {
  open = true
  private readonly connection: FrameConnection
  private readonly messageListeners: ((message: unknown) => void)[] = []
  private readonly closeListeners: (() => void)[] = []
  private readonly early: FrameSocketMessage[] = []

  constructor(
    private readonly canvasId: string,
    metadata: SocketMetadata,
  ) {
    this.connection = {
      metadata,
      send: (message) => queueMicrotask(() => this.deliver(message)),
      close: () => this.end(),
    }
    postgresCanvas(canvasId).connect(this.connection)
  }

  send(command: CanvasCommand) {
    if (!this.open) return
    queueMicrotask(() => {
      if (this.open) postgresCanvas(this.canvasId).receive(this.connection, command)
    })
  }

  close() {
    if (!this.open) return
    postgresCanvas(this.canvasId).disconnect(this.connection)
    this.end()
  }

  onMessage(listener: (message: unknown) => void) {
    this.messageListeners.push(listener)
    for (const message of this.early.splice(0)) listener(message)
  }

  onClose(listener: () => void) {
    this.closeListeners.push(listener)
  }

  private deliver(message: FrameSocketMessage) {
    if (!this.open) return
    if (!this.messageListeners.length) this.early.push(message)
    for (const listener of this.messageListeners) listener(message)
  }

  private end() {
    if (!this.open) return
    this.open = false
    queueMicrotask(() => {
      for (const listener of this.closeListeners) listener()
    })
  }
}
