import type { ResizeHandle } from '../lib/elementResize'
import { RESIZE_CORNERS, RESIZE_EDGES, handleAnchor, handleCursor, movesWidth } from '../lib/elementResize'
import { ROTATE_CORNERS, ROTATE_ZONE_INSET_PX, ROTATE_ZONE_PX, rotateCursor, rotateZoneSide } from '../lib/frameRotate'
import type { RotateCorner } from '../lib/frameRotate'
import { useT } from '../lib/i18n'
import { handleLabelKey } from './ElementResizeHandles'

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
const ROTATE_ZONE_SIZE = `calc(${ROTATE_ZONE_PX}px / var(--zoom, 1))`
const ROTATE_ZONE_INSET = `calc(${ROTATE_ZONE_INSET_PX}px / var(--zoom, 1))`
const GRIP_CLASS = 'pointer-events-none bg-white shadow-[0_0_0_calc(1px/var(--zoom,1))_rgb(60,130,246)]'

/** The grips a selected frame wears: a square in each corner, grabbable
 *  (unmarked) edges along each side, and just outside each corner a zone
 *  that shows the rotate cursor, as Figma does. A press hands the handle to
 *  the frame's own drag, which previews and saves the resize or the turn. */
export function FrameResizeHandles({
  rotation = 0,
  onStart,
  onRotateStart,
}: {
  /** the frame's current rotation, which turns the rotate cursors with it */
  rotation?: number
  onStart: (e: React.PointerEvent<HTMLDivElement>, handle: ResizeHandle) => void
  onRotateStart: (e: React.PointerEvent<HTMLDivElement>, corner: RotateCorner) => void
}) {
  const t = useT()
  return (
    <div data-frame-resize-handles="" className="pointer-events-none absolute inset-0 z-[5]">
      {ROTATE_CORNERS.map((corner) => {
        const side = rotateZoneSide(corner)
        return (
          <div
            key={corner}
            data-frame-rotate-handle={corner}
            aria-label={t('stage.rotate')}
            className="pointer-events-auto absolute touch-none"
            style={{
              left: side.x < 0 ? 0 : '100%',
              top: side.y < 0 ? 0 : '100%',
              width: ROTATE_ZONE_SIZE,
              height: ROTATE_ZONE_SIZE,
              /* the zone's near corner sits a little past the frame's corner,
                 clear of the corner grip's hit box, and the rest of it
                 extends away from the frame */
              transform: `translate(${side.x < 0 ? '-100%' : '0'}, ${side.y < 0 ? '-100%' : '0'}) translate(calc(${side.x} * ${ROTATE_ZONE_INSET}), calc(${side.y} * ${ROTATE_ZONE_INSET}))`,
              cursor: rotateCursor(corner, rotation),
            }}
            onPointerDown={(e) => onRotateStart(e, corner)}
          />
        )
      })}
      {RESIZE_EDGES.map((handle) => {
        const anchor = handleAnchor(handle)
        const horizontal = !movesWidth(handle)
        return (
          <div
            key={handle}
            data-frame-resize-handle={handle}
            aria-label={t(handleLabelKey(handle))}
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
            aria-label={t(handleLabelKey(handle))}
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
