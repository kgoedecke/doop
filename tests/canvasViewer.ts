import { canvasActor, openCanvasSocket } from '../server/frame-sync.ts'
import type { CanvasEvent, FrameChange } from '../src/actor.ts'

/** A browser on the canvas. Frames reach viewers from the canvas actor's
 *  socket, not the room, so its frame changes are what viewers are sent. */
export async function watchCanvas(canvasId: string) {
  const accessVersion = await canvasActor(canvasId).accessVersion()
  const socket = await openCanvasSocket(canvasId, {
    actor: { name: 'Viewer', kind: 'user', color: '#888888' },
    readOnly: true,
    accessVersion,
  })
  const changes: FrameChange[] = []
  let revision = -1
  socket.onMessage((data) => {
    const message = data as Received
    const event = message.type === 'state_update' ? message.changes.committed : message
    if (!event || !('revision' in event)) return
    revision = Math.max(revision, event.revision)
    if (event.type === 'frame-change') changes.push(event)
  })
  await until(() => revision >= 0)
  return {
    /** every frame change sent since the viewer joined */
    changes,
    /** the frame changes sent for one frame, oldest first */
    sentFor: (frameId: string) => changes.filter((change) => change.frame.id === frameId),
    /** resolves once every change the canvas has committed so far has arrived */
    async caughtUp() {
      const { revision: latest } = await canvasActor(canvasId).snapshot()
      await until(() => revision >= latest)
    },
    close: () => socket.close(),
  }
}

type Received = CanvasEvent | { type: 'drag' } | { type: 'state_update'; changes: { committed?: CanvasEvent | null } }

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('The canvas actor did not send the change')
}
