/**
 * The parent's line to a frame's sandboxed document. FrameView registers
 * each iframe's window when its runtime reports ready; anything else on the
 * page (the element properties panel) reaches the live document through
 * these calls instead of holding an iframe ref of its own.
 */

/** The runtime's summary of one element: computed styles resolved to what
 *  the Design panel shows, plus the inline styles the element already carries.
 *  Mirrors `inspect()` in frameRuntime.ts — keep the two in lockstep. */
export interface ElementInfo {
  tag: string
  id: string
  classes: string[]
  parent: { tag: string; id: string; className: string; display: string; flexDirection: string } | null
  /** 1-based place among the parent's children, and how many there are */
  index: number
  count: number
  inline: Record<string, string>
  hasText: boolean
  rect: { x: number; y: number; width: number; height: number }
  position: string
  display: string
  flexDirection: string
  width: number | null
  height: number | null
  minWidth: string
  rowGap: number | null
  columnGap: number | null
  padding: [number | null, number | null, number | null, number | null]
  opacity: number | null
  visibility: string
  backgroundColor: string
  /** top, right, bottom, left */
  borderWidths: [number | null, number | null, number | null, number | null]
  /** style and colour of the first side that draws */
  borderStyle: string
  borderColor: string
  borderRadius: number | null
  color: string
  fontSize: number | null
  fontWeight: string
  fontFamily: string
  textAlign: string
}

/** Inline style changes: a null or empty value removes the property. */
export type StylePatch = Record<string, string | null>

/* A request `doop:<name>` is answered by `doop:<name>-result` carrying the
   same reqId — the convention every runtime request already follows. */
interface PendingAsk {
  win: Window
  replyType: string
  resolve: (reply: Record<string, unknown>) => void
}

const REPLY_TIMEOUT_MS = 2000

const windows = new Map<string, Window>()
const readyListeners = new Map<string, Set<() => void>>()
const pending = new Map<number, PendingAsk>()
let nextReq = 0
let listening = false

function listen() {
  if (listening) return
  listening = true
  window.addEventListener('message', (ev: MessageEvent) => {
    const data = ev.data as { type?: string; reqId?: number } | null
    if (typeof data?.type !== 'string' || typeof data.reqId !== 'number') return
    const ask = pending.get(data.reqId)
    /* the reply must come from the window that was asked — request ids are
       predictable, so another frame's script could otherwise answer for it */
    if (!ask || ask.replyType !== data.type || ev.source !== ask.win) return
    pending.delete(data.reqId)
    ask.resolve(data)
  })
}

export function registerFrameWindow(frameId: string, win: Window) {
  windows.set(frameId, win)
  readyListeners.get(frameId)?.forEach((cb) => cb())
}

export function unregisterFrameWindow(frameId: string, win: Window) {
  if (windows.get(frameId) === win) windows.delete(frameId)
}

/** Runs `cb` each time the frame's runtime (re)registers — a panel opened
 *  before the frame was ready uses this to ask again. Returns the unsubscribe. */
export function onFrameReady(frameId: string, cb: () => void): () => void {
  const set = readyListeners.get(frameId) ?? new Set()
  set.add(cb)
  readyListeners.set(frameId, set)
  return () => {
    set.delete(cb)
    if (set.size === 0) readyListeners.delete(frameId)
  }
}

/** Post `{ type, ...payload }` to the frame and resolve with its reply, or
 *  null when the frame is not registered or never answers. */
export function requestFrame(
  frameId: string,
  type: `doop:${string}`,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const win = windows.get(frameId)
  if (!win) return Promise.resolve(null)
  listen()
  nextReq += 1
  const reqId = nextReq
  return new Promise((resolve) => {
    pending.set(reqId, { win, replyType: `${type}-result`, resolve })
    win.postMessage({ ...payload, type, reqId }, '*')
    /* a frame that unloads mid-request would leave the promise hanging */
    window.setTimeout(() => {
      if (pending.delete(reqId)) resolve(null)
    }, REPLY_TIMEOUT_MS)
  })
}

/* the runtime's replies carry the element summary under `info` */
function infoOf(reply: Record<string, unknown> | null): ElementInfo | null {
  return reply && typeof reply.info === 'object' ? (reply.info as ElementInfo | null) : null
}

/** Computed properties of the element, or null when the selector no longer resolves. */
export async function inspectElement(frameId: string, selector: string): Promise<ElementInfo | null> {
  return infoOf(await requestFrame(frameId, 'doop:inspect', { selector }))
}

/** Write inline styles onto the element. The runtime saves the edited
 *  document through the frame's normal edit path and answers with the
 *  element's fresh properties. */
export async function styleElement(frameId: string, selector: string, styles: StylePatch): Promise<ElementInfo | null> {
  return infoOf(await requestFrame(frameId, 'doop:style', { selector, styles }))
}
