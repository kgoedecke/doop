import { serializeOuter } from 'parse5'
import { CSS_ATTR, type ComponentDef, type InstanceOverrides } from '../shared/components.ts'
import type { Frame } from '../shared/types.ts'
import { contextFor } from './components.ts'
import { renderInstance } from './componentEngine.ts'

/**
 * A sheet of one component in every combination of its enum props, for people in
 * the Components panel and for agents checking a change: variants are CSS, so
 * the only real way to review them is to look at them.
 */

const MAX_VARIANTS = 12
const SHEET_WIDTH = 720
const CELL_HEIGHT = 170

function combinations(def: ComponentDef): Record<string, string>[] {
  let combos: Record<string, string>[] = [{}]
  for (const prop of def.props) {
    if (prop.type !== 'enum' || !prop.options?.length) continue
    combos = combos.flatMap((combo) => prop.options!.map((option) => ({ ...combo, [prop.name]: option })))
    if (combos.length > MAX_VARIANTS) return combos.slice(0, MAX_VARIANTS)
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

export function previewDocument(
  canvasId: string,
  def: ComponentDef,
): { html: string; width: number; height: number; variants: number } {
  const ctx = contextFor(canvasId)
  const combos = combinations(def)
  const cells = combos.map((combo) => {
    const overrides: InstanceOverrides = Object.keys(combo).length ? { props: combo } : {}
    const root = renderInstance(def, def, overrides, '', { ctx, stack: [] })
    return `<figure>${root ? serializeOuter(root) : ''}${
      Object.keys(combo).length ? `<figcaption>${escapeHtml(label(combo))}</figcaption>` : ''
    }</figure>`
  })
  const columns = Math.min(combos.length, 3)
  const rows = Math.ceil(combos.length / columns)
  const html = `<!doctype html><html><head>${stylesFor(canvasId, def)}<style>
html,body{margin:0;background:#fff}
main{display:grid;grid-template-columns:repeat(${columns},1fr);gap:1px;background:#eee;min-height:100vh}
figure{margin:0;background:#fff;padding:20px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;min-width:0;overflow:hidden}
figcaption{font:11px/1.3 ui-monospace,monospace;color:#777}
</style></head><body><main>${cells.join('')}</main></body></html>`
  return { html, width: SHEET_WIDTH, height: rows * CELL_HEIGHT, variants: combos.length }
}

/** The sheet as a frame-shaped value, for the screenshot renderer. */
export function previewFrame(canvasId: string, def: ComponentDef): Frame & { variants: number } {
  const { html, width, height, variants } = previewDocument(canvasId, def)
  const now = Date.now()
  return {
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
    variants,
  }
}
