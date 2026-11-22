import { activeComponents, COMPONENT_ATTR, CSS_ATTR, INSTANCE_ATTR, type ComponentDef } from '../shared/components.ts'
import { canvasPages, COMPONENTS_PAGE, framePageId } from '../shared/pages.ts'
import { resolveToken, TOKEN_BLOCK_ATTR, type DesignToken } from '../shared/designTokens.ts'
import { FONT_BLOCK_ATTR } from '../shared/fonts.ts'
import type { Canvas, Frame } from '../shared/types.ts'
import { findComponentCandidates } from './componentActions.ts'

/**
 * Notes an agent hears right after writing a whole frame or a component: blocks it wrote out
 * three times instead of making a component, colours it hardcoded that the canvas has as tokens,
 * a palette of its own on :root. Agents follow what a tool says at the moment of the mistake far
 * more reliably than a guide read at the start of a session (an agent's own account of building
 * a canvas with neither tokens nor components until a human asked).
 */

/** The third copy of a block is where the guide asks for a component. */
const REPEATS = 3
const MAX_REPEAT_NOTES = 2
/** A frame with this many hardcoded colours on a canvas with no tokens is a palette in hiding. */
const UNTOKENED_COLOURS = 4
const ROOT_PALETTE = 3

/** Repeated structures inside one frame's markup, biggest first. */
function repeatsIn(canvas: Canvas, frame: Frame) {
  /* the threshold goes in first: two panels of three rows each are three rows repeated, not two panels */
  return findComponentCandidates({ ...canvas, frames: [frame] }, MAX_REPEAT_NOTES, REPEATS).filter(
    (candidate) => candidate.elements_each >= 2,
  )
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const DOOP_STYLE = new RegExp(
  `<style\\b[^>]*\\b(?:${TOKEN_BLOCK_ATTR}|${FONT_BLOCK_ATTR}|${CSS_ATTR})\\b[^>]*>[\\s\\S]*?</style>`,
  'gi',
)

/** The CSS the author wrote: their <style> blocks and style attributes, without the blocks Doop writes. */
export function authoredCss(html: string): { sheets: string[]; inline: string[] } {
  const own = html.replace(DOOP_STYLE, '')
  const sheets = [...own.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1] ?? '')
  const inline = [...own.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((match) => match[1] ?? match[2] ?? '')
  return { sheets, inline }
}

/** `#abc` and `#AABBCC` as one key; alpha forms are left alone. */
function normalHex(hex: string): string | null {
  const body = hex.slice(1).toLowerCase()
  if (body.length === 3) return `#${[...body].map((digit) => digit + digit).join('')}`
  return body.length === 6 ? `#${body}` : null
}

/** What CSS says once comments, strings and url(…) are gone: `#abc` in those is no colour. */
function declarationsOnly(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/url\([^)]*\)/gi, ' ')
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ' ')
}

/** Hex colours in declaration values: a sheet's rule bodies (never its selectors), or a style attribute. */
export function hexesIn(css: string, { sheet }: { sheet: boolean }): Set<string> {
  const clean = declarationsOnly(css)
  const bodies = sheet ? [...clean.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1] ?? '') : [clean]
  const found = new Set<string>()
  for (const body of bodies) {
    for (const decl of body.matchAll(/:([^;]+)/g)) {
      for (const match of (decl[1] ?? '').matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        const hex = normalHex(match[0])
        if (hex) found.add(hex)
      }
    }
  }
  return found
}

/** Each colour token's resolved value, by hex, for tokens that hold one value in every theme:
 *  a themed token would change the colour in a frame drawn under another theme. */
function tokenHexes(tokens: readonly DesignToken[], themes: readonly string[]): Map<string, string> {
  const byHex = new Map<string, string>()
  for (const token of tokens) {
    if (token.type !== 'color') continue
    const value = resolveToken(tokens, token.name)
    if (themes.some((theme) => resolveToken(tokens, token.name, theme) !== value)) continue
    const hex = value?.startsWith('#') ? normalHex(value) : null
    if (hex && !byHex.has(hex)) byHex.set(hex, token.name)
  }
  return byHex
}

const COLOUR_VALUE = /^\s*(?:#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\()/

/** Custom properties a frame declares on :root, with whether each holds a colour. */
function rootProperties(sheets: string[]): { name: string; colour: boolean }[] {
  const found: { name: string; colour: boolean }[] = []
  for (const sheet of sheets) {
    for (const block of declarationsOnly(sheet).matchAll(/:root\s*\{([^}]*)\}/g)) {
      for (const decl of (block[1] ?? '').matchAll(/(--[\w-]+)\s*:([^;]+)/g)) {
        found.push({ name: decl[1]!, colour: COLOUR_VALUE.test(decl[2] ?? '') })
      }
    }
  }
  return found
}

function tokenNotes(canvas: Canvas, frame: Frame): string[] {
  const tokens = canvas.tokens ?? []
  const { sheets, inline } = authoredCss(frame.html)
  const notes: string[] = []
  const declared = rootProperties(sheets)
  /* one redefined token is enough: that frame stops following it */
  const clashes = [...new Set(declared.map((property) => property.name))].filter((name) =>
    tokens.some((token) => token.name === name),
  )
  const palette = declared.filter((property) => property.colour && !clashes.includes(property.name))
  if (clashes.length)
    notes.push(
      `TOKENS: this frame redefines canvas tokens on :root (${clashes.slice(0, 4).join(', ')}${clashes.length > 4 ? ', …' : ''}), so it stops following them. Remove those declarations and use var(--…) as it is.`,
    )
  if (palette.length >= ROOT_PALETTE) {
    const named = palette
      .slice(0, 4)
      .map((property) => property.name)
      .join(', ')
    notes.push(
      `TOKENS: this frame declares its own colour palette on :root (${named}${palette.length > 4 ? ', …' : ''}). The canvas cannot see it, and no other frame shares it. Create these with create_tokens${tokens.length ? ' (or use the canvas tokens get_tokens lists)' : ''}, then remove the :root block.`,
    )
  }
  const hexes = new Set([
    ...sheets.flatMap((css) => [...hexesIn(css, { sheet: true })]),
    ...inline.flatMap((css) => [...hexesIn(css, { sheet: false })]),
  ])
  const byHex = tokenHexes(tokens, canvas.tokenThemes ?? [])
  if (byHex.size) {
    const matched = [...hexes].filter((hex) => byHex.has(hex))
    if (matched.length) {
      const pairs = matched
        .slice(0, 4)
        .map((hex) => `${hex} → var(${byHex.get(hex)})`)
        .join(', ')
      notes.push(
        `TOKENS: this frame hardcodes ${plural(matched.length, 'colour', 'colours')} the canvas has as tokens: ${pairs}${matched.length > 4 ? ', …' : ''}. Use the tokens, so a change to one reaches this frame.`,
      )
    }
  } else if (!tokens.length && hexes.size >= UNTOKENED_COLOURS && palette.length < ROOT_PALETTE) {
    notes.push(
      `TOKENS: this canvas has no design tokens, and this frame hardcodes ${hexes.size} colours. Create the palette (and fonts, sizes, radii) with create_tokens and write var(--…), so every frame shares one set of values.`,
    )
  }
  return notes
}

/* ---- the component system: a screen is composed from the canvas's components ---- */

/** A screen worth composing from components: enough markup, and something a product UI is made of. */
const SCREEN_ELEMENTS = 8
const UI_ELEMENT = /<(?:button|input|select|textarea|nav|form)\b|<a\b[^>]*\bhref=/i
const NAMED_COMPONENTS = 6

/** The markup a person sees: the body, without its styles and scripts. */
function bodyMarkup(html: string): string {
  const body = /<body\b[^>]*>([\s\S]*)/i.exec(html)?.[1] ?? html.replace(/<head\b[\s\S]*?<\/head>/i, '')
  return body.replace(/<(style|script)\b[\s\S]*?(?:<\/\1>|$)/gi, '')
}

/** A screen of a product, as opposed to a component's main, a shape on the canvas or a demo. */
function isScreen(canvas: Canvas, frame: Frame): boolean {
  if (frame.demo) return false
  if (frame.html.includes(COMPONENT_ATTR)) return false
  if (/<body\b[^>]*\bdata-doop-canvas-element=/i.test(frame.html)) return false
  const page = canvasPages(canvas).find((candidate) => candidate.id === framePageId(canvas, frame))
  if (page?.name === COMPONENTS_PAGE) return false
  const body = bodyMarkup(frame.html)
  return (body.match(/<[a-z][\w-]*\b/gi)?.length ?? 0) >= SCREEN_ELEMENTS && UI_ELEMENT.test(body)
}

function namedComponents(defs: readonly ComponentDef[]): string {
  const names = defs.slice(0, NAMED_COMPONENTS).map((def) => def.name)
  const more = defs.length - names.length
  return `${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
}

/** Before a screen is written (create_frame with no HTML yet): set up the system, or compose from it. */
export function componentSystemPlan(canvas: Canvas): string {
  const defs = activeComponents(canvas.components)
  if (!defs.length)
    return 'COMPONENT SYSTEM: this canvas has no components yet. Before you write this screen, set up its component system the way a designer sets up a Figma file: create_components with the primitives and patterns it is built from (a Button with its variants, inputs, a badge; the nav, a card, a list row), styled with the canvas tokens. Then compose the screen from them with <doop-use>. One-off layout (a hero composition, section wrappers) stays plain HTML.'
  return `COMPONENT SYSTEM: compose this screen from the canvas's components (${namedComponents(defs)}; list_components shows their props) with <doop-use>. When it needs a reusable piece the system lacks, add it to the system first (create_component) rather than drawing it inline.`
}

/** After a screen is written: built without any component, on a canvas with or without a system. */
export function componentSystemNotes(canvas: Canvas, frame: Frame): string[] {
  if (frame.html.includes(INSTANCE_ATTR) || !isScreen(canvas, frame)) return []
  const defs = activeComponents(canvas.components)
  if (!defs.length)
    return [
      `COMPONENT SYSTEM: this screen is built without components, and the canvas has no component system yet. Set one up the way a designer would in Figma: make the screen's reusable parts (buttons, inputs, nav, cards, rows) components, with create_components, or create_component with frame_id "${frame.id}" and an element's data-doop-id to turn one in place. Then use them through <doop-use>. One-off layout stays plain HTML.`,
    ]
  return [
    `COMPONENT SYSTEM: this canvas's components are ${namedComponents(defs)}, and this screen uses none of them. Where it draws one of those, write <doop-use> instead; where it needs a reusable piece the system lacks, add it (create_component) and use that.`,
  ]
}

/** What a whole-frame write should have reused: components and tokens. */
export function frameReuseNotes(canvas: Canvas, frame: Frame): string[] {
  if (frame.demo) return []
  const notes = componentSystemNotes(canvas, frame)
  const repeats = repeatsIn(canvas, frame).map(
    (repeat) =>
      `REUSE: ${repeat.occurrences} blocks in this frame share one structure (“${repeat.suggested_name}”${repeat.sample_text ? `, e.g. “${repeat.sample_text.slice(0, 40)}”` : ''}). Make one a component (create_component with frame_id "${frame.id}" and element "${repeat.example.element}"), then replace each other copy with <doop-use component="${repeat.suggested_name}" …> in edit_frame_html, its differing text as props.`,
  )
  return [...notes, ...repeats, ...tokenNotes(canvas, frame)]
}

/** What a component's main repeats by hand that should be a component nested in it. */
export function componentReuseNotes(canvas: Canvas, def: ComponentDef, autoProps?: boolean): string[] {
  const main = canvas.frames.find((frame) => frame.id === def.mainFrameId)
  if (!main || !def.template) return []
  const repeats = repeatsIn(canvas, { ...main, html: def.template })
  const notes = repeats.map(
    (repeat) =>
      `REUSE: ${repeat.occurrences} elements inside “${def.name}” share one structure (“${repeat.suggested_name}”${repeat.sample_text ? `, e.g. “${repeat.sample_text.slice(0, 40)}”` : ''}). Make one of them a component of its own (create_component with its html and css), then update_component “${def.name}” with a <doop-use> for each: components nest, and a change to the inner one reaches every main and instance using it.`,
  )
  if (repeats.length && autoProps === false)
    notes.push(
      `REUSE: auto_props=false, so none of the text in those repeated elements can change per instance of “${def.name}”. A list that changes belongs in nested components or a slot.`,
    )
  return notes
}
