import type { CSSProperties } from 'react'

/** A hairline on every design-px boundary, `width` px thick in the layer's
 *  own units; the tile size is the caller's. */
export function pixelGridLines(width: number): CSSProperties {
  const line = `rgb(128 128 128 / 0.16) ${width}px, transparent ${width}px`
  return { backgroundImage: `linear-gradient(to right, ${line}), linear-gradient(to bottom, ${line})` }
}

/** A frame's pixel grid: over its document, under everything drawn on the
 *  frame (pins, threads, grips), so the grid never covers the canvas's own UI.
 *  It sits in the world, laid out at CSS zoom `layoutZoom` (Stage), where one
 *  design px is the tile and 1/layoutZoom px is one layout px of line. The
 *  Stage fades it in with the zoom through `--pixel-grid`. */
export function PixelGrid({ layoutZoom }: { layoutZoom: number }) {
  return (
    <div
      data-pixel-grid="frame"
      className="pointer-events-none absolute inset-0"
      style={{ ...pixelGridLines(1 / layoutZoom), backgroundSize: '1px 1px', opacity: 'var(--pixel-grid, 0)' }}
    />
  )
}
