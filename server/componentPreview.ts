import { serializeOuter } from 'parse5'
import { z } from 'zod'
import { CSS_ATTR, type ComponentDef, type InstanceOverrides } from '../shared/components.ts'
import type { Frame } from '../shared/types.ts'
import { withCanvasFaces } from './canvasFaces.ts'
import { wholeDocument } from './frameCompose.ts'
import { contextFor } from './components.ts'
import { renderInstance } from './componentEngine.ts'

const MAX_PREVIEWS = 12
const SHEET_WIDTH = 720
const CELL_HEIGHT = 170

export const previewDescription = `Check a component after creating or editing it. Omit props for its default appearance, pass a value to check one variant, or pass a list to compare values side by side (e.g. {"tone": ["solid", "ghost"]}). Unspecified props keep their defaults. Request up to ${MAX_PREVIEWS} combinations per image.`
export const previewProps = z.record(z.string(), z.union([z.string(), z.array(z.string()).min(1)])).optional()

export class PreviewQueryError extends Error {
  override name = 'PreviewQueryError'
}

export function previewCombinations(def: ComponentDef, props: z.infer<typeof previewProps> = {}) {
  let combos: Record<string, string>[] = [{}]
  for (const [name, selection] of Object.entries(props)) {
    const prop = def.props.find((candidate) => candidate.name === name)
    if (!prop) {
      const known = def.props.map((candidate) => candidate.name)
      throw new PreviewQueryError(`“${def.name}” has no prop “${name}”; its props: ${known.join(', ') || 'none'}`)
    }
    const values = [...new Set(Array.isArray(selection) ? selection : [selection])]
    const allowed = prop.type === 'boolean' ? ['true', 'false'] : prop.options
    const wrong = allowed && values.find((value) => !allowed.includes(value))
    if (allowed && wrong !== undefined)
      throw new PreviewQueryError(`“${wrong}” is not a value of “${name}”; its values: ${allowed.join(', ')}`)
    if (combos.length * values.length > MAX_PREVIEWS)
      throw new PreviewQueryError(`Request at most ${MAX_PREVIEWS} combinations per image. Narrow the prop values.`)
    combos = combos.flatMap((combo) => values.map((value) => ({ ...combo, [name]: value })))
  }
  return combos
}

function stylesFor(canvasId: string, def: ComponentDef, seen = new Set<string>()): string {
  if (seen.has(def.id)) return ''
  seen.add(def.id)
  const nested = [...def.template.matchAll(/component="([^"]+)"/g)].map((match) => {
    const dependency = contextFor(canvasId).find(match[1]!)
    return dependency ? stylesFor(canvasId, dependency, seen) : ''
  })
  return `${nested.join('')}${def.head.join('\n')}<style ${CSS_ATTR}="${def.id}">\n${def.css}\n</style>\n`
}

const label = (combo: Record<string, string>) =>
  Object.entries(combo)
    .map(([name, value]) => `${name}=${value}`)
    .join(' · ')

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;')

export function previewDocument(canvasId: string, def: ComponentDef, combos: Record<string, string>[] = [{}]) {
  const ctx = contextFor(canvasId)
  const cells = combos.map((combo) => {
    const overrides: InstanceOverrides = Object.keys(combo).length ? { props: combo } : {}
    const root = renderInstance(def, def, overrides, '', { ctx, stack: [] })
    return `<figure>${root ? serializeOuter(root) : ''}${
      Object.keys(combo).length ? `<figcaption>${escapeHtml(label(combo))}</figcaption>` : ''
    }</figure>`
  })
  const columns = Math.min(combos.length, 3)
  const rows = Math.ceil(combos.length / columns)
  /* the canvas's tokens and fonts, as on every frame: a component styled through
     var(--…) would otherwise preview with none of its values */
  const html = withCanvasFaces(
    canvasId,
    `<!doctype html><html><head>${stylesFor(canvasId, def)}<style>
html,body{margin:0;background:#fff}
main{display:grid;grid-template-columns:repeat(${columns},1fr);gap:1px;background:#eee;min-height:100vh}
figure{margin:0;background:#fff;padding:20px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;min-width:0;overflow:hidden}
figcaption{font:11px/1.3 ui-monospace,monospace;color:#777}
</style></head><body><main>${cells.join('')}</main></body></html>`,
  )
  return { html, width: SHEET_WIDTH, height: rows * CELL_HEIGHT, variants: combos.length }
}

/** The sheet as a frame-shaped value for the screenshot renderer. */
export function previewFrame(canvasId: string, def: ComponentDef, combos: Record<string, string>[]): Frame {
  const { html, width, height } = previewDocument(canvasId, def, combos)
  const now = Date.now()
  /* the sheet brings its own stylesheets, in its own order */
  return wholeDocument({
    id: `component-preview-${def.id}`,
    canvasId,
    name: def.name,
    x: 0,
    y: 0,
    width,
    height,
    html,
    createdAt: now,
    updatedAt: now,
    updatedBy: def.updatedBy,
  })
}
