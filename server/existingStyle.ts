import { canvasPages, COMPONENTS_PAGE, framePageId } from '../shared/pages.ts'
import type { Canvas } from '../shared/types.ts'
import { authoredCss, hexesIn } from './reuseNotes.ts'

/**
 * What an agent should know before adding to a canvas that already has a look: the colours
 * and fonts its frames share. Without it an agent asked
 * for "one more page" copies hex values and redraws the nav by hand, and the canvas ends up
 * with seven copies of a header instead of a component and a set of tokens.
 */

/** Below this many frames there is no established style to read, only a first frame. */
const MIN_FRAMES = 2
const MAX_COLOURS = 8
const MAX_FONTS = 4

export interface ExistingStyle {
  frames: number
  /** most shared first; only filled when the canvas has no tokens */
  colours: { value: string; frames: number }[]
  fonts: { family: string; frames: number }[]
}

const GENERIC_FONTS = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'inherit',
  'initial',
  'unset',
  '-apple-system',
  'blinkmacsystemfont',
])

/** The first named family of each font-family declaration, `var(--…)` and generics left out. */
function fontsIn(css: string): Set<string> {
  const found = new Set<string>()
  for (const match of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    const first = (match[1] ?? '')
      .split(',')[0]
      ?.trim()
      .replace(/^['"]|['"]$/g, '')
    if (!first || first.startsWith('var(') || GENERIC_FONTS.has(first.toLowerCase())) continue
    found.add(first)
  }
  return found
}

/** How many frames name each value, most first. */
function tally(perFrame: Set<string>[], limit: number): { value: string; frames: number }[] {
  const counts = new Map<string, number>()
  for (const values of perFrame) for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts]
    .map(([value, frames]) => ({ value, frames }))
    .sort((a, b) => b.frames - a.frames)
    .slice(0, limit)
}

/** The established style of a canvas, or null when it has fewer than two of the user's frames. */
export function existingStyle(canvas: Canvas): ExistingStyle | null {
  /* the Components page holds the library's mains, not screens in the canvas's style */
  const library = new Set(
    canvasPages(canvas)
      .filter((page) => page.name === COMPONENTS_PAGE)
      .map((page) => page.id),
  )
  const frames = canvas.frames.filter((frame) => !frame.demo && !library.has(framePageId(canvas, frame)))
  if (frames.length < MIN_FRAMES) return null
  /* with tokens the palette is already named: nothing to read off the frames */
  if ((canvas.tokens ?? []).length) return { frames: frames.length, colours: [], fonts: [] }
  const css = frames.map((frame) => authoredCss(frame.html))
  const colours = tally(
    css.map(
      ({ sheets, inline }) =>
        new Set([
          ...sheets.flatMap((sheet) => [...hexesIn(sheet, { sheet: true })]),
          ...inline.flatMap((style) => [...hexesIn(style, { sheet: false })]),
        ]),
    ),
    MAX_COLOURS,
  )
  const fonts = tally(
    css.map(({ sheets, inline }) => new Set([...sheets, ...inline].flatMap((block) => [...fontsIn(block)]))),
    MAX_FONTS,
  ).map(({ value, frames }) => ({ family: value, frames }))
  return { frames: frames.length, colours, fonts }
}

/** What to do with it, in the words both get_canvas and the resident kickoff use. */
export function existingStyleBrief(style: ExistingStyle, { tokens }: { tokens: boolean }): string {
  const lines = [
    `This canvas already has a style: ${style.frames} frames set it. New work follows it rather than a fresh brief.`,
  ]
  if (!tokens) {
    const colours = style.colours.map((colour) => `${colour.value} (${colour.frames} frames)`).join(', ')
    const fonts = style.fonts.map((font) => `${font.family} (${font.frames} frames)`).join(', ')
    lines.push(
      'It has no design tokens yet. Before your first new frame, read its values off the existing frames' +
        (colours
          ? ` (shared colours: ${colours}` + (fonts ? `; fonts: ${fonts})` : ')')
          : fonts
            ? ` (fonts: ${fonts})`
            : '') +
        ' and get_frame on a page or two for type sizes, radii and spacing, then create them with create_tokens by role ' +
        'and write var(--name) in what you add.',
    )
  }
  lines.push(
    'Do not rewrite the existing frames to use new tokens or components (no replace_matching) unless the human asked: ' +
      'when you finish, offer to bring them onto the same tokens and components.',
  )
  return lines.join(' ')
}
