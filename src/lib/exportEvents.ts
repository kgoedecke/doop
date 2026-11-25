import { posthog } from './posthog'

/** The control an export started from. */
export type ExportSource = 'export_modal' | 'frame_menu' | 'inspector' | 'element_menu' | 'element_panel' | 'shortcut'

/** Where an export went. */
export type ExportDestination = 'png' | 'jpg' | 'svg' | 'pdf' | 'html'

/** One export, whichever control started it, as `frames_exported`: where it
 *  went, how many frames, whether it was a whole frame or one element, and
 *  which control asked. */
export function trackExport(
  destination: ExportDestination,
  frameCount: number,
  source: ExportSource,
  target: 'frame' | 'element' = 'frame',
) {
  posthog.capture('frames_exported', { destination, frame_count: frameCount, source, target })
}

/** Copy as PNG, of a whole frame or one element. */
export function trackPngCopy(target: 'frame' | 'element', source: ExportSource) {
  posthog.capture('png_copied', { target, source })
}
