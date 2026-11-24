/**
 * What a resident run (server/resident.ts) changed and must look at before it may finish:
 * a frame it wrote needs a screenshot after its last write; a component it changed needs one
 * look, at its main, any frame using it, or screenshot_component. Frames that only follow a
 * component were not edited. Tool results say what is left (`stillToCheck`), since the
 * Claude Plan harness has no reminder turn.
 */

/** One component this run changed, and the frames that show it. */
export interface ComponentCheck {
  name: string
  /** its main and every frame holding an instance, as the change left them */
  frameIds: Set<string>
  /** looked at since its last change */
  verified: boolean
  /** that look reached the model (a screenshot on the last turn never did) */
  seen: boolean
}

/** A component change as a tool reports it (server/componentTools.ts `ToolResult.changed`). */
export interface ComponentChange {
  id: string
  name: string
  frameIds: readonly string[]
}

export interface CheckState {
  /** every frame the run wrote */
  mutatedFrames: Set<string>
  /** frames the run must look at without having written them (imported sources) */
  verificationFrames: Set<string>
  verifiedFrames: Set<string>
  /** verified frames whose screenshots reached the model */
  seenVerified: Set<string>
  componentChecks: Map<string, ComponentCheck>
  /** false: the model cannot see images, so nothing has to be looked at */
  vision: boolean
}

/** Something still to look at: one frame, or one component shown by any of its frames. */
export interface Unchecked {
  frameIds: string[]
  component?: { id: string; name: string }
}

/** A frame the run wrote: any earlier look at it no longer counts. */
export function noteFrameChange(state: CheckState, frameId: string) {
  state.mutatedFrames.add(frameId)
  unverifyFrame(state, frameId)
}

/** A change to a frame undoes every check of it, seen or not. */
export function unverifyFrame(state: Pick<CheckState, 'verifiedFrames' | 'seenVerified'>, frameId: string) {
  state.verifiedFrames.delete(frameId)
  state.seenVerified.delete(frameId)
}

/** A component the run changed: one new look is due. One with no frames to show (a deletion,
 *  a linked import) asks for none and leaves an earlier change owed. */
export function noteComponentChange(state: CheckState, change: ComponentChange) {
  if (!change.frameIds.length) return
  state.componentChecks.set(change.id, {
    name: change.name,
    frameIds: new Set(change.frameIds),
    verified: false,
    seen: false,
  })
}

/** A screenshot checks its frame, and each changed component the frame still holds (`shows`). */
export function noteFrameScreenshot(state: CheckState, frameId: string, shows: (componentId: string) => boolean) {
  if (state.mutatedFrames.has(frameId) || state.verificationFrames.has(frameId)) state.verifiedFrames.add(frameId)
  for (const [componentId, check] of state.componentChecks)
    if (check.frameIds.has(frameId) && shows(componentId)) check.verified = true
}

/** A preview of a component (screenshot_component): it checks that component's change. */
export function noteComponentScreenshot(state: CheckState, componentId: string) {
  const check = state.componentChecks.get(componentId)
  if (check) check.verified = true
}

/** Every result so far reached the model: an API turn starts, or the harness asks for a call. */
export function markChecksSeen(state: CheckState) {
  state.seenVerified = new Set(state.verifiedFrames)
  for (const check of state.componentChecks.values()) check.seen = check.verified
}

/** What is still unchecked; frames gone from the canvas never count. `seen`: only looks the model saw. */
export function unchecked(
  state: CheckState,
  onCanvas: (frameId: string) => boolean,
  { seen = false }: { seen?: boolean } = {},
): Unchecked[] {
  if (!state.vision) return []
  const looked = seen ? state.seenVerified : state.verifiedFrames
  const frames = [...new Set([...state.mutatedFrames, ...state.verificationFrames])]
    .filter((id) => !looked.has(id) && onCanvas(id))
    .map((id) => ({ frameIds: [id] }))
  const components = [...state.componentChecks].flatMap(([id, check]) => {
    if (seen ? check.seen : check.verified) return []
    const frameIds = [...check.frameIds].filter(onCanvas)
    return frameIds.length ? [{ frameIds, component: { id, name: check.name } }] : []
  })
  return [...frames, ...components]
}

/** A stable key for what is left, to tell whether a call changed it. */
export function uncheckedKey(items: readonly Unchecked[]): string {
  return items.map((item) => item.component?.id ?? item.frameIds[0]).join(',')
}

/* a component shown on a hundred screens is named by a few of them */
const FRAMES_NAMED = 4

/** What is left, as the line a tool result ends with. `nameOf` gives a frame's name. */
export function stillToCheck(items: readonly Unchecked[], nameOf: (frameId: string) => string): string {
  if (!items.length) return 'Everything this run changed has been checked.'
  const frame = (id: string) => `"${nameOf(id)}" (${id})`
  const parts = items.map((item) => {
    if (!item.component) return `screenshot_frame ${frame(item.frameIds[0]!)}`
    const named = item.frameIds.slice(0, FRAMES_NAMED).map(frame)
    const more = item.frameIds.length - named.length
    return `component ${item.component.name}: screenshot_frame any one of ${named.join(', ')}${more > 0 ? ` (or ${more} more using it)` : ''}, or screenshot_component`
  })
  return `Still to check before you finish: ${parts.join('; ')}.`
}
