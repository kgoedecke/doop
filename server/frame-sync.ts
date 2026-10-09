import { actors } from '../generated/actors/index.js'

if (process.env.NODE_ENV === 'production' && !process.env.TERSE_ACTOR_URL?.trim()) {
  throw new Error(
    'TERSE_ACTOR_URL is required in production. Configure a separately hosted actor API with a public WebSocket endpoint.',
  )
}

export const canvasIndex = actors.CanvasIndex.get
export const prepareCanvasSocket = actors.CanvasIndex.prepareWebsocket
export const frameActor = actors.FrameActor.get
export const prepareFrameSocket = actors.FrameActor.prepareWebsocket

/** Bound activation and payload pressure when loading a canvas. */
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
