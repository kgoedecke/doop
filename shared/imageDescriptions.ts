/**
 * Image descriptions: a small vision model writes, once per uploaded image,
 * what the picture shows, so an agent reading the canvas later knows a frame
 * holds a checkout screenshot rather than "Screenshot 2026-11-03.png". The
 * canvas owner's preference says whether it runs and on whose model.
 */

export const IMAGE_DESCRIPTION_MODES = ['off', 'account', 'server'] as const
export type ImageDescriptionMode = (typeof IMAGE_DESCRIPTION_MODES)[number]

export function isImageDescriptionMode(value: unknown): value is ImageDescriptionMode {
  return IMAGE_DESCRIPTION_MODES.some((mode) => mode === value)
}

/** Why no model would describe an image right now. */
export type DescriberReason = 'off' | 'text-only' | 'no-model'

/** What would describe the next image on this user's canvases. */
export type DescriberStatus = { label: string; reason?: undefined } | { label: null; reason: DescriberReason }

export interface ImageDescriptionPreference {
  mode: ImageDescriptionMode
  describer: DescriberStatus
}

/** One image a frame references, as agents see it in get_canvas / get_frame. */
export interface FrameImage {
  src: string
  /** null while the describer has not got to it, or gave up */
  description: string | null
}
