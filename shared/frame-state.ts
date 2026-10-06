import type { Frame } from './types.js'

export type FrameLayout = Omit<Frame, 'name' | 'html'>
export type LayoutPatch = Partial<Pick<Frame, 'x' | 'y' | 'width' | 'height'>>
export type FrameContent = Pick<Frame, 'id' | 'canvasId' | 'name' | 'html' | 'updatedAt' | 'updatedBy'>

export function layoutOf(frame: FrameLayout): FrameLayout {
  const { id, canvasId, x, y, width, height, createdAt, updatedAt, updatedBy, demo } = frame
  return { id, canvasId, x, y, width, height, createdAt, updatedAt, updatedBy, ...(demo === undefined ? {} : { demo }) }
}

export function contentOf(frame: FrameContent): FrameContent {
  const { id, canvasId, name, html, updatedAt, updatedBy } = frame
  return { id, canvasId, name, html, updatedAt, updatedBy }
}

export function composeFrame(layout: FrameLayout, content: FrameContent): Frame {
  if (layout.id !== content.id || layout.canvasId !== content.canvasId) throw new Error('Frame identity mismatch')
  return {
    ...layout,
    name: content.name,
    html: content.html,
    updatedAt: Math.max(layout.updatedAt, content.updatedAt),
    updatedBy: content.updatedAt > layout.updatedAt ? content.updatedBy : layout.updatedBy,
  }
}
