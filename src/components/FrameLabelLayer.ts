import { createContext } from 'react'

/** The Stage's screen-space layer the selected frame's size badge is portalled
 *  into: outside the zoomed world, so it keeps its size, its gap to the frame
 *  and crisp text at every zoom. Frame names are not here: they sit inside
 *  their frame so they stack with it. Null outside a Stage. */
export const FrameLabelLayer = createContext<HTMLElement | null>(null)
