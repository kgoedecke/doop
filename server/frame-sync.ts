import { actors } from '../generated/actors/index.js'

// The generated Terse client supports both the local runtime and managed cloud.
if (!process.env.TERSE_ACTOR_URL && process.env.DURABLE_ACTORS_CONTROL_PLANE_URL) {
  process.env.TERSE_ACTOR_URL = `${process.env.DURABLE_ACTORS_CONTROL_PLANE_URL}/v1/projects/${process.env.DURABLE_ACTORS_PROJECT_ID || 'local'}/actors`
  process.env.TERSE_API_KEY = process.env.DURABLE_ACTORS_SECRET
}

export const canvasIndex = actors.CanvasIndex.get
export const frameActor = actors.FrameActor.get
export const prepareCanvasSocket = actors.CanvasIndex.prepareWebsocket
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
