import { createContext } from 'react'

/** The Stage's screen-space layer frame names are portalled into: outside the
 *  zoomed world, so a name keeps its size, its gap to the frame and crisp text
 *  at every zoom, the way Figma draws them. Null outside a Stage. */
export const FrameLabelLayer = createContext<HTMLElement | null>(null)
