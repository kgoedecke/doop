export type PresentationSize = { width: number; height: number }
export type PresentationMode = 'fit' | 'width' | 'custom'

export function presentationScale(
  mode: PresentationMode,
  zoom: number,
  stage: PresentationSize,
  frame: PresentationSize,
) {
  if (mode === 'custom') return zoom
  const widthScale = stage.width / frame.width
  return mode === 'width' ? widthScale : Math.min(widthScale, stage.height / frame.height)
}

/** Keep automatic fit sizes reachable even for unusually large or small frames. */
export function presentationZoomLimits(stage: PresentationSize, frame: PresentationSize) {
  return {
    min: Math.min(0.1, presentationScale('fit', 1, stage, frame)),
    max: Math.max(4, presentationScale('width', 1, stage, frame)),
  }
}

/** Preserve the design point under the cursor (or viewport centre) during zoom. */
export function zoomedScroll(
  scroll: number,
  anchor: number,
  viewport: number,
  design: number,
  before: number,
  after: number,
) {
  const oldMargin = Math.max(0, (viewport - design * before) / 2)
  const newMargin = Math.max(0, (viewport - design * after) / 2)
  const point = (scroll + anchor - oldMargin) / before
  return Math.max(0, Math.min(design * after - viewport, point * after + newMargin - anchor))
}
