/* The canvas tools (bottom toolbar): what a pointer-down means depends on the
   tool, on what it landed on, and on a few modifiers. Resolved here, in one
   place, so the Stage (background) and FrameView (frames) agree on it. */

import type { PlainMessageKey } from './i18n'

export type DrawingTool = 'rectangle' | 'circle' | 'path' | 'text' | 'frame'
export type Tool = 'select' | 'hand' | 'comment' | DrawingTool

export function isDrawingTool(tool: Tool): tool is DrawingTool {
  return tool === 'rectangle' || tool === 'circle' || tool === 'path' || tool === 'text' || tool === 'frame'
}

/** `label` is a message key: translate it where the tool is drawn. */
export const TOOLS: { id: Tool; label: PlainMessageKey; key: string }[] = [
  { id: 'select', label: 'canvas.toolSelect', key: 'V' },
  { id: 'hand', label: 'canvas.toolHand', key: 'H' },
  { id: 'frame', label: 'canvas.toolFrame', key: 'F' },
  { id: 'rectangle', label: 'canvas.toolRectangle', key: 'R' },
  { id: 'circle', label: 'canvas.toolCircle', key: 'O' },
  { id: 'path', label: 'canvas.toolPath', key: 'P' },
  { id: 'text', label: 'canvas.toolText', key: 'T' },
  { id: 'comment', label: 'canvas.toolComment', key: 'C' },
]

export type PointerAction =
  /** drag the viewport */
  | 'pan'
  /** drag out a selection rectangle on the background */
  | 'marquee'
  /** select and move/resize the frame under the pointer (current behaviour) */
  | 'frame-drag'
  /** start a comment on the element under the pointer */
  | 'comment'
  /** start a comment pinned to the canvas at the pointer */
  | 'comment-canvas'
  /** draw an element, on the background or inside a frame */
  | 'draw'
  /** nothing — the press is not ours */
  | 'none'

export interface PointerContext {
  tool: Tool
  target: 'background' | 'frame'
  /** `PointerEvent.button`: 0 = primary, 1 = middle */
  button: number
  pointerType: string
  /** the space bar is held: a temporary Hand, whatever the tool */
  spaceHeld: boolean
}

export function resolvePointerAction({ tool, target, button, pointerType, spaceHeld }: PointerContext): PointerAction {
  /* the middle button pans anywhere, in any tool */
  if (button === 1) return 'pan'
  if (button !== 0) return 'none'
  if (tool === 'hand' || spaceHeld) return 'pan'
  if (isDrawingTool(tool)) return 'draw'
  /* a finger on the background pans: touch has no space bar, and one-finger
     pan is how phones move around. The Comment tool is the exception — a tap
     is how a phone places a comment; the stage still pans a finger that
     moves (it starts both and lets the distance decide) */
  if (target === 'background') {
    if (tool === 'comment') return 'comment-canvas'
    if (pointerType === 'touch') return 'pan'
    return 'marquee'
  }
  return tool === 'comment' ? 'comment' : 'frame-drag'
}

/** The tool a bare key press picks, or null when the key is not a tool key. */
export function toolForKey(key: string): Tool | null {
  const found = TOOLS.find((t) => t.key.toLowerCase() === key.toLowerCase())
  return found?.id ?? null
}
