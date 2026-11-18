import { canvasPages, COMPONENTS_PAGE, framePageId } from '../../shared/pages'
import type { ClientCanvas, Frame } from '../../shared/types'

type FlightCanvas = Pick<ClientCanvas, 'id' | 'pages' | 'frames' | 'components'>

/** A component's main is a building block the agent files away, not what the
 *  person asked for: one made from markup lands on the Components page, and
 *  the frame can arrive before the component naming it does. */
function isComponentMain(canvas: FlightCanvas, frame: Frame): boolean {
  if (canvas.components?.some((def) => def.mainFrameId === frame.id)) return true
  const pageId = framePageId(canvas, frame)
  return canvasPages(canvas).find((page) => page.id === pageId)?.name === COMPONENTS_PAGE
}

/** The first frame not in `known` that a composer submit should fly to, or
 *  undefined while none has arrived. Component mains are passed over, so the
 *  person stays on their page until the deliverable itself shows up. */
export function arrivedDeliverable(canvas: FlightCanvas, known: ReadonlySet<string>): Frame | undefined {
  return canvas.frames.find((frame) => !known.has(frame.id) && !isComponentMain(canvas, frame))
}
