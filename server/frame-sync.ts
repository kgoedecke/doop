import { actors } from '../generated/actors/index.js'

// The generated Terse client supports both the local runtime and managed cloud.
if (!process.env.TERSE_ACTOR_URL && process.env.DURABLE_ACTORS_CONTROL_PLANE_URL) {
  process.env.TERSE_ACTOR_URL = `${process.env.DURABLE_ACTORS_CONTROL_PLANE_URL}/v1/projects/${process.env.DURABLE_ACTORS_PROJECT_ID || 'local'}/actors`
  process.env.TERSE_API_KEY = process.env.DURABLE_ACTORS_SECRET
}

export const frameActor = actors.CanvasFrames.get
export const prepareFrameSocket = actors.CanvasFrames.prepareWebsocket
