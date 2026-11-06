import { create } from 'zustand'
import { api } from './api'
import type { CustomFont } from '../../shared/fonts'

/** The font library of the canvas being edited (its workspace's, or its
 *  owner's), which the Design panel offers and the frame save path reads to
 *  add the @font-face rules a design starts using. */
interface CanvasFontsState {
  canvasId: string | null
  fonts: CustomFont[]
}

export const useCanvasFonts = create<CanvasFontsState>(() => ({ canvasId: null, fonts: [] }))

let latest = 0

/** Fetch a canvas's library; a failure leaves the canvas with none, which
 *  only hides the Custom group (the server still adds faces on save). */
export function loadCanvasFonts(canvasId: string): void {
  if (useCanvasFonts.getState().canvasId !== canvasId) useCanvasFonts.setState({ canvasId, fonts: [] })
  /* only the newest request lands: a reply for the canvas's old workspace
     arriving after the new one must not put the old library back */
  const request = ++latest
  api.canvasFonts(canvasId).then(
    (fonts) => {
      if (request === latest && useCanvasFonts.getState().canvasId === canvasId) useCanvasFonts.setState({ fonts })
    },
    (e: unknown) => console.error('[fonts] library could not be loaded', e),
  )
}

export function canvasFonts(): CustomFont[] {
  return useCanvasFonts.getState().fonts
}
