import type { Canvas, CanvasPageInfo, Frame } from './types.ts'
import { canvasPages, pageFrames } from './pages.ts'

/**
 * Clickable prototypes. Interactions live in the frame HTML as data
 * attributes on the element that triggers them, so they persist, sync and
 * version with the frame, and agents author them with the ordinary HTML
 * tools. Spec: .context/specs/prototyping.md.
 *
 * One interaction (the canonical form the editor writes for one):
 *   data-doop-on="click" data-doop-action="navigate:<frameId>"
 *   data-doop-transition="dissolve" data-doop-duration="300"
 * Several on one element (what the editor writes for two or more):
 *   data-doop-interactions='[{"on":"click","action":"navigate:abc"},{"on":"key:Escape","action":"back"}]'
 */

export const PROTO_TRIGGERS = ['click', 'hover', 'press', 'delay', 'key'] as const
export type ProtoTrigger = (typeof PROTO_TRIGGERS)[number]

export const PROTO_ACTIONS = ['navigate', 'back', 'overlay', 'close-overlay', 'scroll-to', 'url'] as const
export type ProtoAction = (typeof PROTO_ACTIONS)[number]

export const PROTO_TRANSITIONS = [
  'instant',
  'dissolve',
  'slide-left',
  'slide-right',
  'slide-up',
  'slide-down',
  'push-left',
  'push-right',
] as const
export type ProtoTransition = (typeof PROTO_TRANSITIONS)[number]

export const DEFAULT_PROTO_DURATION = 300
export const MAX_PROTO_DURATION = 5000
export const MAX_PROTO_DELAY = 600_000

export const PROTO_ATTRS = {
  on: 'data-doop-on',
  action: 'data-doop-action',
  transition: 'data-doop-transition',
  duration: 'data-doop-duration',
  interactions: 'data-doop-interactions',
} as const

/** Matches every element that may carry an interaction. */
export const PROTO_SELECTOR = `[${PROTO_ATTRS.on}],[${PROTO_ATTRS.interactions}]`

export interface Interaction {
  trigger: ProtoTrigger
  /** `delay`: milliseconds after the frame is shown */
  delay?: number
  /** `key`: the KeyboardEvent.key that fires it ("ArrowRight", "Escape", " ") */
  key?: string
  action: ProtoAction
  /** a frame id (navigate, overlay), a CSS selector (scroll-to) or an http(s) URL (url) */
  target?: string
  transition: ProtoTransition
  duration: number
}

/** The raw attribute values of one element; null or undefined when absent. */
export interface InteractionAttrs {
  on?: string | null
  action?: string | null
  transition?: string | null
  duration?: string | null
  interactions?: string | null
}

/**
 * Parse an element's interaction attributes: the single-attribute form first,
 * then every entry of the JSON form. Invalid entries are dropped, never
 * repaired. SELF-CONTAINED ON PURPOSE: the frame runtime inlines this
 * function's source (`parseInteractions.toString()`) into the sandboxed
 * iframe, so it must not reference anything outside its own body.
 */
export function parseInteractions(attrs: InteractionAttrs): Interaction[] {
  const transitions = [
    'instant',
    'dissolve',
    'slide-left',
    'slide-right',
    'slide-up',
    'slide-down',
    'push-left',
    'push-right',
  ]
  const maxEntries = 20
  function str(v: unknown): string | null {
    return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : null
  }
  function one(on: unknown, action: unknown, transition: unknown, duration: unknown): Interaction | null {
    const trigger = str(on)
    const act = str(action)
    if (!trigger || !act) return null
    const out: Interaction = { trigger: 'click', action: 'back', transition: 'instant', duration: 300 }
    let m: RegExpExecArray | null
    if (trigger === 'click' || trigger === 'hover' || trigger === 'press') out.trigger = trigger
    else if ((m = /^delay:(\d{1,7})$/.exec(trigger))) {
      out.trigger = 'delay'
      out.delay = Math.min(Number(m[1]), 600000)
    } else if ((m = /^key:(.{1,32})$/.exec(trigger))) {
      out.trigger = 'key'
      out.key = m[1] === 'Space' ? ' ' : m[1]
    } else return null

    if (act === 'back' || act === 'close-overlay') out.action = act
    else if ((m = /^(navigate|overlay):([\w-]{1,64})$/.exec(act))) {
      out.action = m[1] === 'overlay' ? 'overlay' : 'navigate'
      out.target = m[2]
    } else if ((m = /^scroll-to:(.{1,300})$/.exec(act))) {
      out.action = 'scroll-to'
      out.target = (m[1] ?? '').trim()
      if (!out.target) return null
    } else if ((m = /^url:(.{1,2000})$/.exec(act))) {
      let url: URL
      try {
        url = new URL((m[1] ?? '').trim())
      } catch {
        return null
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
      out.action = 'url'
      out.target = url.href
    } else return null

    const t = str(transition)
    if (t && transitions.indexOf(t) !== -1) out.transition = t as ProtoTransition
    const d = str(duration)
    if (d && /^\d{1,7}$/.test(d)) out.duration = Math.min(Number(d), 5000)
    return out
  }

  const list: Interaction[] = []
  if (attrs.on != null || attrs.action != null) {
    const single = one(attrs.on, attrs.action, attrs.transition, attrs.duration)
    if (single) list.push(single)
  }
  if (attrs.interactions) {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(attrs.interactions)
    } catch {
      parsed = null
    }
    const entries = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : []
    for (const entry of entries) {
      if (list.length >= maxEntries) break
      if (!entry || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      const parsedEntry = one(e.on, e.action, e.transition, e.duration)
      if (parsedEntry) list.push(parsedEntry)
    }
  }
  return list
}

/** The trigger as written in `data-doop-on`. */
export function triggerString(i: Pick<Interaction, 'trigger' | 'delay' | 'key'>): string {
  if (i.trigger === 'delay') return `delay:${i.delay ?? 0}`
  if (i.trigger === 'key') return `key:${i.key === ' ' ? 'Space' : (i.key ?? '')}`
  return i.trigger
}

/** The action as written in `data-doop-action`. */
export function actionString(i: Pick<Interaction, 'action' | 'target'>): string {
  return i.action === 'back' || i.action === 'close-overlay' ? i.action : `${i.action}:${i.target ?? ''}`
}

/**
 * The canonical attributes for a list of interactions: one interaction is
 * written as the single-attribute form (transition and duration only when
 * they differ from the defaults), two or more as `data-doop-interactions`.
 * Every attribute the other form would use is set to null (= remove), so an
 * element never carries both forms after an editor write.
 */
export function interactionAttributes(list: Interaction[]): Record<string, string | null> {
  const none: Record<string, string | null> = {
    [PROTO_ATTRS.on]: null,
    [PROTO_ATTRS.action]: null,
    [PROTO_ATTRS.transition]: null,
    [PROTO_ATTRS.duration]: null,
    [PROTO_ATTRS.interactions]: null,
  }
  const [only] = list
  if (!only) return none
  if (list.length === 1) {
    return {
      ...none,
      [PROTO_ATTRS.on]: triggerString(only),
      [PROTO_ATTRS.action]: actionString(only),
      [PROTO_ATTRS.transition]: only.transition === 'instant' ? null : only.transition,
      [PROTO_ATTRS.duration]: only.duration === DEFAULT_PROTO_DURATION ? null : String(only.duration),
    }
  }
  const entries = list.map((i) => ({
    on: triggerString(i),
    action: actionString(i),
    ...(i.transition === 'instant' ? {} : { transition: i.transition }),
    ...(i.duration === DEFAULT_PROTO_DURATION ? {} : { duration: i.duration }),
  }))
  return { ...none, [PROTO_ATTRS.interactions]: JSON.stringify(entries) }
}

/** Interactions whose action leaves the frame for another one. */
export function targetsFrame(i: Interaction): i is Interaction & { target: string } {
  return (i.action === 'navigate' || i.action === 'overlay') && !!i.target
}

/* ---- reading interactions out of HTML without a DOM (server, MCP) ---- */

export interface ScannedInteractive {
  tag: string
  id?: string
  /** a short human label: id, class or the first words of its text */
  label: string
  interactions: Interaction[]
}

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole
    }
    return ENTITIES[code.toLowerCase()] ?? whole
  })
}

const ATTR_RE = /\s*([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y

/** Parse one start tag's attributes, starting just after the tag name. */
function readAttributes(html: string, from: number): { attrs: Map<string, string>; end: number } {
  const attrs = new Map<string, string>()
  let at = from
  while (at < html.length) {
    while (at < html.length && /\s/.test(html[at]!)) at++
    if (html[at] === '>' || html.startsWith('/>', at)) break
    ATTR_RE.lastIndex = at
    const m = ATTR_RE.exec(html)
    if (!m || m[0].length === 0) {
      at++
      continue
    }
    const name = (m[1] ?? '').toLowerCase()
    if (name && !attrs.has(name)) attrs.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''))
    at = ATTR_RE.lastIndex
  }
  return { attrs, end: html.indexOf('>', at) }
}

/** The text right after a start tag, for a label: up to the next tag. */
function textAfter(html: string, from: number): string {
  const next = html.indexOf('<', from)
  return decodeEntities(html.slice(from, next === -1 ? undefined : next))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
}

/** Every element in the HTML that carries interactions. Script and style
 *  bodies are skipped, in any letter case (HTML tag names are, and the `i`
 *  flag makes the `\1` close tag match case-blind too); elements a script
 *  creates at runtime are not seen. */
export function scanInteractions(html: string): ScannedInteractive[] {
  const out: ScannedInteractive[] = []
  const tagRe = /<!--[\s\S]*?-->|<(script|style)(?=[\s/>])[\s\S]*?<\/\1\s*>|<([a-z][\w:-]*)/gi
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(html))) {
    const tag = m[2]
    if (m[1]) {
      /* a script or style can carry the attributes on its own start tag */
      const own = readAttributes(html, m.index + m[1].length + 1)
      collect(m[1].toLowerCase(), own.attrs, '')
      continue
    }
    if (!tag) continue
    const { attrs, end } = readAttributes(html, m.index + tag.length + 1)
    collect(tag.toLowerCase(), attrs, end === -1 ? '' : textAfter(html, end + 1))
    if (end !== -1) tagRe.lastIndex = end + 1
  }
  return out

  function collect(tag: string, attrs: Map<string, string>, text: string) {
    if (!attrs.has(PROTO_ATTRS.on) && !attrs.has(PROTO_ATTRS.interactions) && !attrs.has(PROTO_ATTRS.action)) return
    const interactions = parseInteractions({
      on: attrs.get(PROTO_ATTRS.on),
      action: attrs.get(PROTO_ATTRS.action),
      transition: attrs.get(PROTO_ATTRS.transition),
      duration: attrs.get(PROTO_ATTRS.duration),
      interactions: attrs.get(PROTO_ATTRS.interactions),
    })
    const id = attrs.get('id') || undefined
    const cls = attrs.get('class')?.trim().split(/\s+/)[0]
    const label = id ? `#${id}` : text ? `"${text}"` : cls ? `.${cls}` : tag
    out.push({ tag, ...(id ? { id } : {}), label, interactions })
  }
}

/* ---- flows ---- */

/** The frame a page's prototype starts on: its flow start when that frame is
 *  still on the page, otherwise its first frame (top-left reading order). */
export function flowStartFrame(canvas: Canvas, pageId: string): Frame | null {
  const frames = pageFrames(canvas, pageId).filter((f) => !f.hidden)
  const page = canvasPages(canvas).find((p) => p.id === pageId)
  const start = page?.startFrameId ? frames.find((f) => f.id === page.startFrameId) : undefined
  if (start) return start
  return [...frames].sort((a, b) => a.y - b.y || a.x - b.x)[0] ?? null
}

/** The page whose flow starts on this frame, if any. */
export function pageStartingAt(pages: CanvasPageInfo[], frameId: string): CanvasPageInfo | undefined {
  return pages.find((p) => p.startFrameId === frameId)
}

export interface PrototypeLink {
  fromFrameId: string
  element: string
  interaction: Interaction
  /** set when the target frame does not exist on this canvas */
  problem?: string
}

/** Every interaction on the canvas, with targets checked against its frames. */
export function prototypeLinks(canvas: Canvas): PrototypeLink[] {
  const ids = new Set(canvas.frames.map((f) => f.id))
  const links: PrototypeLink[] = []
  for (const frame of canvas.frames) {
    for (const el of scanInteractions(frame.html)) {
      for (const interaction of el.interactions) {
        const missing = targetsFrame(interaction) && !ids.has(interaction.target)
        links.push({
          fromFrameId: frame.id,
          element: el.label,
          interaction,
          ...(missing ? { problem: `target frame ${interaction.target} does not exist on this canvas` } : {}),
        })
      }
    }
  }
  return links
}
