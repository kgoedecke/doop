import type { Presence } from '../../shared/types'
import type { useStore } from './store'

type State = ReturnType<typeof useStore.getState>

/** Where a peer is on the canvas, as somewhere the camera can fly to: a
 *  frame, or a bare world point. People are wherever their cursor is (or the
 *  frame they have picked); agents are the frame they are editing, streaming
 *  into, or last touched on their newest task. Undefined when unknown. */
export function locatePresence(
  p: Presence,
  s: State,
): { frameId: string } | { point: { x: number; y: number } } | undefined {
  const frames = s.canvas?.frames ?? []
  const exists = (id: string | null | undefined) => (id && frames.some((f) => f.id === id) ? id : undefined)

  if (p.kind === 'user') {
    const cursor = s.cursors[p.clientId] ?? p.cursor
    if (cursor) return { point: cursor }
    const picked = exists(p.activeFrameId)
    return picked ? { frameId: picked } : undefined
  }

  const editing = exists(p.activeFrameId)
  if (editing) return { frameId: editing }
  const streaming = exists(Object.entries(s.streams).find(([, actor]) => actor.name === p.name)?.[0])
  if (streaming) return { frameId: streaming }
  const task = s.tasks.find((t) => t.agentName === p.name && t.frameIds?.length)
  for (let i = (task?.frameIds?.length ?? 0) - 1; i >= 0; i--) {
    const id = exists(task?.frameIds?.[i])
    if (id) return { frameId: id }
  }
  return undefined
}
