/* Shapes the runtime's modules hand each other and the editor. Every
   coordinate is in design px: the frame document's own CSS px, the bleed
   margin taken off (bleed.ts). */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export interface Scale {
  x: number
  y: number
}

/** a css property name to its value, as the editor sent it: null or ''
 *  removes the property (a value structured clone left undefined does not) */
export type StylePatch = Record<string, string | number | null | undefined>
