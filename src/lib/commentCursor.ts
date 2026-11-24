import type { CSSProperties } from 'react'
import { colorFor } from '../../shared/types'
import { getIdentity } from './identity'

/* The Comment tool's cursor is a small copy of the pin a click drops: the
   teardrop (three round corners, the lower left one tight) in your own
   colour, a white collar with a faint dark hairline so it reads on both
   canvases, and nothing inside, so the point stays visible. Pins sit
   centred on the point they mark, so the hotspot is the cursor's centre and
   the pin lands exactly where the cursor showed it. */
const pinSvg = (fill: string): string =>
  `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' data-cursor='comment'>` +
  `<path d='M12 1A11 11 0 0 1 23 12A11 11 0 0 1 12 23H5A4 4 0 0 1 1 19V12A11 11 0 0 1 12 1Z' fill='#fff' stroke='rgba(0,0,0,.22)' stroke-width='.75'/>` +
  `<path d='M12 3A9 9 0 0 1 21 12A9 9 0 0 1 12 21H5A2 2 0 0 1 3 19V12A9 9 0 0 1 12 3Z' fill='${fill}'/>` +
  `</svg>`

/** The CSS `cursor` value for a comment pin of this colour, crosshair where a
 *  browser shows no image cursors. */
export function commentCursor(fill: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(pinSvg(fill))}") 12 12, crosshair`
}

/** Sets `--comment-cursor`, which the `cursor-comment` utility reads, to the
 *  signed-in person's pin colour. */
export function commentCursorStyle(): CSSProperties {
  return { '--comment-cursor': commentCursor(colorFor(getIdentity().name)) } as CSSProperties
}
