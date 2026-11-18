import { createHash } from 'node:crypto'
import { INSTANCE_ATTR, type ComponentDef } from '../shared/components.ts'
import type { DesignToken } from '../shared/designTokens.ts'
import { composeFrame, type ComposeOptions } from '../shared/frameCompose.ts'
import type { Canvas, Frame, WireFrame } from '../shared/types.ts'
import { carriesHtml, htmlLoaded, withHtml } from './frameHtml.ts'
import { resourcesOf } from './frameCompose.ts'

/**
 * Frames for connections that cannot compose (the native apps, a tab on an older
 * bundle): they render exactly the HTML they are sent, so each frame goes to them
 * composed, and goes again when the canvas's tokens or a component's rules change
 * what was composed into it. What a connection was last sent is remembered per
 * frame as a short key of `composeFrame(...).shared` (what the canvas supplied),
 * never the document. Only frames a change can reach are composed, once each
 * however many such connections are in the room.
 */

/** frame id → the key of what the canvas supplied to the document last sent */
export type SentFrames = Map<string, string>

export interface LegacyFrame<F extends WireFrame = WireFrame> {
  frame: F
  key: string
}

const keyOf = (shared: string) => createHash('sha1').update(shared).digest('base64')

/** The frame with its composed document, and the key of what was supplied to it. */
export function legacyFrame<F extends WireFrame>(
  canvas: Canvas | undefined,
  frame: F,
  options?: ComposeOptions,
): LegacyFrame<F> {
  if (!canvas || !carriesHtml(frame)) return { frame, key: '' }
  const source = frame.html as string
  const composed = composeFrame(source, resourcesOf(canvas), options)
  return {
    frame: composed.html === source ? frame : (withHtml(frame as unknown as Frame, composed.html) as unknown as F),
    key: keyOf(composed.shared),
  }
}

/* The tokens of each canvas as its legacy connections last knew them, so a `tokens`
   message (which carries the whole list) can be narrowed to the names that changed. */
const knownTokens = new Map<string, { values: Map<string, string>; themes: string }>()

const tokenText = (token: DesignToken) => `${token.value}\n${JSON.stringify(token.themes ?? {})}`

function snapshot(canvas: Canvas) {
  return {
    values: new Map((canvas.tokens ?? []).map((token) => [token.name, tokenText(token)])),
    themes: (canvas.tokenThemes ?? []).join(','),
  }
}

/** A legacy connection joined: the canvas's tokens now are the ones its frames were composed with. */
export function rememberTokens(canvas: Canvas) {
  knownTokens.set(canvas.id, snapshot(canvas))
}

export function forgetTokens(canvasId: string) {
  knownTokens.delete(canvasId)
}

/** The token names whose value changed since the last look, with every token whose value
 *  reads one of them (an alias, a `color-mix`); 'all' when the themes changed, since every
 *  token's theme blocks do then, or when nothing was remembered. */
function changedTokens(canvas: Canvas): ReadonlySet<string> | 'all' {
  const before = knownTokens.get(canvas.id)
  const now = snapshot(canvas)
  knownTokens.set(canvas.id, now)
  if (!before || before.themes !== now.themes) return 'all'
  const changed = new Set<string>()
  for (const name of new Set([...before.values.keys(), ...now.values.keys()]))
    if (before.values.get(name) !== now.values.get(name)) changed.add(name)
  /* dependents, through either side's values: a token that stopped aliasing a changed one changed too */
  for (let grew = true; grew;) {
    grew = false
    for (const values of [before.values, now.values])
      for (const [name, text] of values) {
        if (changed.has(name) || ![...changed].some((other) => text.includes(other))) continue
        changed.add(name)
        grew = true
      }
  }
  return changed
}

export type SharedChange = { tokens: true } | { componentId: string }

const instanceOf = (id: string) => ` ${INSTANCE_ATTR}="${id}"`

/** Can this change reach what is composed into the frame? A string check, so a frame it
 *  cannot reach is never composed. Over-inclusive (a name is matched as a substring). */
function reaches(html: string, names: ReadonlySet<string> | 'all', components: readonly ComponentDef[]): boolean {
  const named = (text: string) =>
    names === 'all' ? text.includes('var(') : [...names].some((name) => text.includes(name))
  if (named(html)) return true
  if (!html.includes(INSTANCE_ATTR)) return false
  return components.some((def) => named(def.css) && html.includes(instanceOf(def.id)))
}

/**
 * The loaded frames whose composed document a shared-style change altered for at least
 * one of `viewers`, each composed once, with the viewers to send it to (their `sent`
 * entry is brought up to date). A frame a viewer was never sent with its HTML is not its.
 */
export function restyledFrames<V extends { sent: SentFrames }>(
  canvas: Canvas,
  change: SharedChange,
  viewers: readonly V[],
  skip: (frame: Frame) => boolean = () => false,
): { frame: Frame; to: V[] }[] {
  if (!viewers.length) return []
  const names = 'tokens' in change ? changedTokens(canvas) : undefined
  if (names !== undefined && names !== 'all' && !names.size) return []
  const components = canvas.components ?? []
  const restyled: { frame: Frame; to: V[] }[] = []
  for (const frame of canvas.frames) {
    if (!htmlLoaded(frame) || skip(frame)) continue
    if (!viewers.some((viewer) => viewer.sent.has(frame.id))) continue
    const reached =
      'componentId' in change
        ? frame.html.includes(instanceOf(change.componentId))
        : reaches(frame.html, names!, components)
    if (!reached) continue
    const composed = legacyFrame(canvas, frame)
    const to = viewers.filter((viewer) => {
      const before = viewer.sent.get(frame.id)
      return before !== undefined && before !== composed.key
    })
    for (const viewer of to) viewer.sent.set(frame.id, composed.key)
    if (to.length) restyled.push({ frame: composed.frame, to })
  }
  return restyled
}
