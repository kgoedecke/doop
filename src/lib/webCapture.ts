import { api } from './api'
import { useStore } from './store'
import { recordCreate } from './history'
import { frameCenterPosition, stageViewportSize } from './framePlacement'

export const CAPTURE_PREFIX = 'DOOP_CAPTURE_V1\n'

/** Clipboard content is untrusted, including content bearing our marker. */
export function parseWebCapture(text: string) {
  if (!text.startsWith(CAPTURE_PREFIX)) throw new Error('Not a Doop capture')
  if (text.length > 4_000_000) throw new Error('Capture is too large')
  const value = JSON.parse(text.slice(CAPTURE_PREFIX.length))
  if (
    typeof value?.html !== 'string' ||
    typeof value.name !== 'string' ||
    !Number.isInteger(value.width) ||
    !Number.isInteger(value.height) ||
    value.width < 1 ||
    value.width > 30000 ||
    value.height < 1 ||
    value.height > 100000 ||
    new TextEncoder().encode(value.html).length > 3_000_000
  )
    throw new Error('Invalid capture. Try a smaller section.')
  const doc = new DOMParser().parseFromString(value.html, 'text/html')
  doc
    .querySelectorAll(
      'script, iframe, frame, frameset, object, embed, applet, portal, fencedframe, meta, base, link, template, foreignObject',
    )
    .forEach((el) => el.remove())
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on') || ['srcdoc', 'action', 'formaction', 'ping', 'srcset', 'autofocus'].includes(name))
        el.removeAttribute(attr.name)
      if (
        ['href', 'src', 'xlink:href', 'poster'].includes(name) &&
        !/^(https?:|data:image\/(?:png|jpeg|webp|gif);|#)/i.test(attr.value)
      )
        el.removeAttribute(attr.name)
    }
  }
  const csp = doc.createElement('meta')
  csp.httpEquiv = 'Content-Security-Policy'
  csp.content =
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src https: http: data:; font-src https: http: data:; form-action 'none'; base-uri 'none'"
  doc.head.prepend(csp)
  return {
    name: value.name.slice(0, 200),
    width: value.width as number,
    height: value.height as number,
    html: '<!doctype html>' + doc.documentElement.outerHTML,
  }
}

export async function pasteWebCapture(canvasId: string, text: string) {
  const capture = parseWebCapture(text)
  const state = useStore.getState()
  const position = frameCenterPosition(state.viewport, stageViewportSize(), capture)
  const frame = await api.createFrame(canvasId, { ...capture, ...position, pageId: state.activePageId ?? undefined })
  recordCreate(frame)
  useStore.getState().selectMany([frame.id])
}
