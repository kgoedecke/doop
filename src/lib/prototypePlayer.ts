import {
  actionString,
  parseInteractions,
  triggerString,
  type Interaction,
  type ProtoTransition,
} from '../../shared/prototype'

/** How the two screens of a navigation move: keyframes for the screen coming
 *  in and the one going out, and which of them is drawn on top. Back plays
 *  the arriving transition in reverse, as Figma does. */
export interface TransitionFrames {
  incoming: Keyframe[]
  outgoing: Keyframe[]
  outgoingOnTop: boolean
}

const STILL: Keyframe[] = []

const DIRECTION: Record<string, [number, number]> = {
  left: [100, 0],
  right: [-100, 0],
  up: [0, 100],
  down: [0, -100],
}

function offset([dx, dy]: [number, number], sign = 1): Keyframe {
  return { transform: `translate(${dx * sign}%, ${dy * sign}%)` }
}

const AT_REST: Keyframe = { transform: 'translate(0%, 0%)' }

export function transitionFrames(kind: ProtoTransition, back: boolean): TransitionFrames {
  if (kind === 'instant') return { incoming: STILL, outgoing: STILL, outgoingOnTop: false }
  if (kind === 'dissolve')
    return back
      ? { incoming: STILL, outgoing: [{ opacity: 1 }, { opacity: 0 }], outgoingOnTop: true }
      : { incoming: [{ opacity: 0 }, { opacity: 1 }], outgoing: STILL, outgoingOnTop: false }
  const [style, side] = kind.split('-') as ['slide' | 'push', string]
  const dir = DIRECTION[side] ?? DIRECTION.left!
  if (style === 'slide')
    return back
      ? { incoming: STILL, outgoing: [AT_REST, offset(dir)], outgoingOnTop: true }
      : { incoming: [offset(dir), AT_REST], outgoing: STILL, outgoingOnTop: false }
  return back
    ? { incoming: [offset(dir, -1), AT_REST], outgoing: [AT_REST, offset(dir)], outgoingOnTop: false }
    : { incoming: [offset(dir), AT_REST], outgoing: [AT_REST, offset(dir, -1)], outgoingOnTop: false }
}

/** Re-validate an interaction that crossed the sandbox: a script in the frame
 *  can post anything, so the player trusts only what the parser accepts. */
export function sanitizeInteraction(raw: unknown): Interaction | null {
  if (!raw || typeof raw !== 'object') return null
  const i = raw as Partial<Interaction>
  try {
    const [parsed] = parseInteractions({
      on: triggerString({ trigger: i.trigger ?? 'click', delay: i.delay, key: i.key }),
      action: actionString({ action: i.action ?? 'back', target: i.target }),
      transition: typeof i.transition === 'string' ? i.transition : null,
      duration: typeof i.duration === 'number' ? String(i.duration) : null,
    })
    return parsed ?? null
  } catch {
    return null
  }
}

/** The scale that fits a frame inside the viewport, letterboxed. */
export function fitScale(frame: { width: number; height: number }, viewport: { w: number; h: number }): number {
  if (frame.width <= 0 || frame.height <= 0) return 1
  return Math.min(viewport.w / frame.width, viewport.h / frame.height)
}

/** Where a player screen sits in the flow, as its browser history entry
 *  records it: the frame shown and how many screens deep it is. */
export interface ProtoPlace {
  frameId: string
  depth: number
}

export function protoHistoryState(frameId: string, depth: number): { doopProto: true } & ProtoPlace {
  return { doopProto: true, frameId, depth }
}

/** The place a popstate landed on; null for an entry the player did not write. */
export function readProtoHistory(state: unknown): ProtoPlace | null {
  if (!state || typeof state !== 'object') return null
  const s = state as Partial<{ doopProto: unknown } & ProtoPlace>
  if (s.doopProto !== true || typeof s.frameId !== 'string') return null
  if (typeof s.depth !== 'number' || !Number.isInteger(s.depth) || s.depth < 0) return null
  return { frameId: s.frameId, depth: s.depth }
}

/** How the player follows the browser to `target`: nothing when it is the
 *  screen already shown, Back (its transition reversed) when it is the screen
 *  one below on the stack, otherwise a jump straight to it. Depth, not the
 *  frame id, tells the screens apart, so A → B → A walks back through B. */
export function historyStep(stack: readonly ProtoPlace[], target: ProtoPlace): 'none' | 'back' | 'jump' {
  const top = stack.at(-1)
  if (top && top.depth === target.depth && top.frameId === target.frameId) return 'none'
  const prev = stack.at(-2)
  if (top && prev && prev.depth === target.depth && prev.frameId === target.frameId && top.depth === prev.depth + 1)
    return 'back'
  return 'jump'
}
