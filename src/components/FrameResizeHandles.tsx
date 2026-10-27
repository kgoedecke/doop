import type { ResizeHandle } from '../lib/elementResize'
import { RESIZE_CORNERS, RESIZE_EDGES, handleAnchor, handleCursor, handleLabel, movesWidth } from '../lib/elementResize'

/* on-screen pixels, divided by the Stage's `--zoom` so a grip stays the
   same size at every zoom, like the selection outline's hairline — the same
   furniture a selected element wears (ElementResizeHandles) */
const GRIP_PX = 6
const EDGE_PX = 8
/* a corner's hit box is wider than the square it draws: a frame's corner is
   the thing people grab most, and a six-pixel target is a hard catch */
const CORNER_HIT_PX = 14
const GRIP_SIZE = `calc(${GRIP_PX}px / var(--zoom, 1))`
const EDGE_SIZE = `calc(${EDGE_PX}px / var(--zoom, 1))`
const CORNER_HIT_SIZE = `calc(${CORNER_HIT_PX}px / var(--zoom, 1))`
const GRIP_CLASS = 'pointer-events-none bg-white shadow-[0_0_0_calc(1px/var(--zoom,1))_rgb(60,130,246)]'

/** The grips a selected frame wears: a square in each corner, grabbable
 *  (unmarked) edges along each side. A press hands the handle to the
 *  frame's own drag, which previews and saves the resize. */
export function FrameResizeHandles({
  onStart,
}: {
  onStart: (e: React.PointerEvent<HTMLDivElement>, handle: ResizeHandle) => void
}) {
  return (
    <div data-frame-resize-handles="" className="pointer-events-none absolute inset-0 z-[5]">
      {RESIZE_EDGES.map((handle) => {
        const anchor = handleAnchor(handle)
        const horizontal = !movesWidth(handle)
        return (
          <div
            key={handle}
            data-frame-resize-handle={handle}
            aria-label={handleLabel(handle)}
            className="pointer-events-auto absolute touch-none"
            style={{
              left: `${anchor.x * 100}%`,
              top: `${anchor.y * 100}%`,
              width: horizontal ? '100%' : EDGE_SIZE,
              height: horizontal ? EDGE_SIZE : '100%',
              transform: 'translate(-50%, -50%)',
              cursor: handleCursor(handle),
            }}
            onPointerDown={(e) => onStart(e, handle)}
          />
        )
      })}
      {RESIZE_CORNERS.map((handle) => {
        const anchor = handleAnchor(handle)
        return (
          <div
            key={handle}
            data-frame-resize-handle={handle}
            aria-label={handleLabel(handle)}
            className="pointer-events-auto absolute flex touch-none items-center justify-center"
            style={{
              left: `${anchor.x * 100}%`,
              top: `${anchor.y * 100}%`,
              width: CORNER_HIT_SIZE,
              height: CORNER_HIT_SIZE,
              transform: 'translate(-50%, -50%)',
              cursor: handleCursor(handle),
            }}
            onPointerDown={(e) => onStart(e, handle)}
          >
            <div className={GRIP_CLASS} style={{ width: GRIP_SIZE, height: GRIP_SIZE }} />
          </div>
        )
      })}
    </div>
  )
}
