/**
 * World-space top-left for a new frame of the given size, centered in the
 * current viewport.
 *
 * Same math `pasteFrameCentered` (frameClipboard.ts) already uses for ⌘V,
 * pulled out so the toolbar's "Add frame" can use it too: a frame you add
 * lands where you're looking, instead of always at the right edge of the
 * canvas (which can be off-screen on a large board - see issue #98).
 */
export function frameCenterPosition(
  viewport: { x: number; y: number; zoom: number },
  viewportSize: { width: number; height: number },
  frameSize: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: (viewportSize.width / 2 - viewport.x) / viewport.zoom - frameSize.width / 2,
    y: (viewportSize.height / 2 - viewport.y) / viewport.zoom - frameSize.height / 2,
  }
}
