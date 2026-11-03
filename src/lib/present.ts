import { canvasPages } from '../../shared/pages'
import { flowStartFrame } from '../../shared/prototype'
import type { Canvas } from '../../shared/types'

/** The frame the prototype player opens on: the selected frame, else the
 *  page's flow start (its start frame, or its topmost visible one), else
 *  nothing to present. The Play button and ⌘⌥↩ agree through this. */
export function presentStartFrame(
  canvas: Canvas | null,
  selectedId: string | null,
  activePageId: string | null,
): string | null {
  if (selectedId) return selectedId
  if (!canvas) return null
  return flowStartFrame(canvas, activePageId ?? canvasPages(canvas)[0]!.id)?.id ?? null
}
