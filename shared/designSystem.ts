/**
 * The design system a canvas designs with: one global stylesheet (tokens and
 * base rules) plus a library of reusable components, sorted into groups.
 *
 * A library belongs to a scope: the workspace a canvas lives in, else its
 * owner's personal space, else (an unowned canvas) the canvas itself — so
 * every canvas of a team draws from the same components.
 *
 * Frames stay self-contained HTML. An instance is any element carrying
 * `data-doop-component="<slug>"`; on every durable frame write the server
 * stamps the CSS and JS of the components the frame uses, and the global
 * stylesheet, into the document as `data-doop-library` blocks
 * (`stampLibrary`). Exports, screenshots and copies therefore render without
 * knowing about the library, and editing a component restamps every frame
 * that uses it.
 */

export type LibraryScope = `workspace:${string}` | `user:${string}` | `canvas:${string}`

/** The scope whose library a canvas draws from. */
export function libraryScopeOf(canvas: { id: string; ownerId?: string; workspaceId?: string }): LibraryScope {
  if (canvas.workspaceId) return `workspace:${canvas.workspaceId}`
  if (canvas.ownerId) return `user:${canvas.ownerId}`
  return `canvas:${canvas.id}`
}

export interface PresetGroup {
  id: string
  name: string
  /** the component kinds the group offers as ready-made starting points */
  kinds: readonly string[]
}

/** Groups every library starts with. Custom groups are added next to them. */
export const PRESET_GROUPS: readonly PresetGroup[] = [
  {
    id: 'buttons',
    name: 'Buttons',
    kinds: ['Button', 'ButtonGroup', 'CloseButton', 'ToggleButton', 'ToggleButtonGroup'],
  },
  { id: 'collections', name: 'Collections', kinds: ['Dropdown', 'ListBox', 'TagGroup'] },
  {
    id: 'colors',
    name: 'Colors',
    kinds: ['ColorArea', 'ColorField', 'ColorPicker', 'ColorSlider', 'ColorSwatch', 'ColorSwatchPicker'],
  },
  { id: 'controls', name: 'Controls', kinds: ['Slider', 'Switch'] },
  { id: 'data-display', name: 'Data display', kinds: ['Badge', 'Chip', 'Table'] },
  {
    id: 'date-time',
    name: 'Date and time',
    kinds: ['Calendar', 'DateField', 'DatePicker', 'DateRangePicker', 'RangeCalendar', 'TimeField'],
  },
  {
    id: 'feedback',
    name: 'Feedback and loading',
    kinds: ['Alert', 'Meter', 'ProgressBar', 'ProgressCircle', 'Skeleton', 'Spinner'],
  },
  {
    id: 'forms',
    name: 'Forms',
    kinds: [
      'Checkbox',
      'CheckboxGroup',
      'Description',
      'ErrorMessage',
      'FieldError',
      'Fieldset',
      'Form',
      'Input',
      'InputGroup',
      'InputOTP',
      'Label',
      'NumberField',
      'RadioGroup',
      'SearchField',
      'TextField',
      'TextArea',
    ],
  },
  { id: 'layout', name: 'Layout', kinds: ['Card', 'Separator', 'Surface', 'Toolbar'] },
  { id: 'media', name: 'Media', kinds: ['Avatar', 'AvatarGroup'] },
  {
    id: 'navigation',
    name: 'Navigation',
    kinds: ['Accordion', 'Breadcrumbs', 'Disclosure', 'DisclosureGroup', 'Link', 'Pagination', 'Tabs'],
  },
  {
    id: 'overlays',
    name: 'Overlays',
    kinds: ['AlertDialog', 'Drawer', 'Modal', 'Popover', 'Toast', 'Tooltip', 'Sheet'],
  },
  { id: 'pickers', name: 'Pickers', kinds: ['Autocomplete', 'ComboBox', 'Select'] },
  { id: 'typography', name: 'Typography', kinds: ['Kbd', 'Typography'] },
  { id: 'utilities', name: 'Utilities', kinds: ['ScrollShadow'] },
]

export function isPresetGroup(id: string): boolean {
  return PRESET_GROUPS.some((group) => group.id === id)
}

/** A group as the library lists it: a preset, or one a person added. */
export interface ComponentGroup {
  id: string
  name: string
  description?: string
  preset: boolean
  kinds: readonly string[]
}

/** A named piece of markup with its own look, shown beside the default. */
export interface ComponentVariant {
  name: string
  html: string
}

export interface LibraryComponent {
  id: string
  /** unique in its scope; what `data-doop-component` names */
  slug: string
  name: string
  /** a preset group id or a custom group's id */
  groupId: string
  /** the preset kind it implements ("Button"), if any */
  kind?: string
  /** when to use it — written for the people and agents reaching for it */
  description: string
  /** the default markup; its root carries `data-doop-component="<slug>"` */
  html: string
  /** rules for this component only: shared values come from the global stylesheet */
  css: string
  /** optional behaviour; runs once per frame with `elements` = every instance */
  js: string
  variants: ComponentVariant[]
  createdAt: number
  updatedAt: number
  updatedBy: string
}

export interface DesignSystemStyles {
  /** tokens (`:root` custom properties), fonts and base rules every component builds on */
  globalCss: string
  /** usage rules for agents: spacing rhythm, tone, do / don't */
  notes: string
  updatedAt: number
  updatedBy: string
}

export interface LibrarySnapshot {
  scope: LibraryScope
  /** false until someone saved styles or a component: the styles are then only a suggestion */
  initialized: boolean
  styles: DesignSystemStyles
  groups: ComponentGroup[]
  components: LibraryComponent[]
  /** may the viewer change it */
  canEdit: boolean
}

export const MAX_COMPONENTS = 300
export const MAX_CUSTOM_GROUPS = 40
export const MAX_GLOBAL_CSS_CHARS = 60_000
export const MAX_NOTES_CHARS = 8_000
export const MAX_COMPONENT_HTML_CHARS = 20_000
export const MAX_COMPONENT_CSS_CHARS = 20_000
export const MAX_COMPONENT_JS_CHARS = 20_000
export const MAX_COMPONENT_VARIANTS = 12
export const MAX_DESCRIPTION_CHARS = 1_000
export const MAX_NAME_CHARS = 80
export const COMPONENT_SLUG_RE = /^[a-z][a-z0-9-]{0,63}$/

/** "ToggleButtonGroup" -> "toggle-button-group"; any title -> a slug. */
export function slugify(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+|-+$/g, '')
    .slice(0, 64)
}

export interface DesignToken {
  name: string
  value: string
}

/** The custom properties a stylesheet defines, in order, last definition winning. */
export function cssTokens(css: string): DesignToken[] {
  const tokens = new Map<string, string>()
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) {
    const [, name = '', value = ''] = match
    tokens.set(name, value.trim())
  }
  return [...tokens].map(([name, value]) => ({ name, value }))
}

/** The component slugs a document's instances name. */
export function componentSlugsIn(html: string): Set<string> {
  const slugs = new Set<string>()
  for (const match of html.matchAll(/\bdata-doop-component\s*=\s*["']?([a-z][a-z0-9-]*)/g)) {
    if (match[1]) slugs.add(match[1])
  }
  return slugs
}

/** Puts `data-doop-component="<slug>"` on the markup's first element, unless
 *  an element already names the slug (any other slug there is replaced). */
export function ensureInstanceAttribute(html: string, slug: string): string {
  if (componentSlugsIn(html).has(slug)) return html
  const open = /<([a-zA-Z][\w-]*)(\s[^>]*?)?(\/?)>/.exec(html)
  if (!open) return html
  const [tag, name = '', attrs = '', selfClose = ''] = open
  const kept = attrs.replace(/\s+data-doop-component\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/, '').trimEnd()
  const stamped = `<${name}${kept} data-doop-component="${slug}"${selfClose ? ' /' : ''}>`
  return html.slice(0, open.index) + stamped + html.slice(open.index + tag.length)
}

/** Gives the element carrying `data-doop-component="<slug>"` a `data-name`
 *  (what the Layers panel shows) unless it already has one. */
export function ensureInstanceName(html: string, slug: string, name: string): string {
  const open = new RegExp(
    `<[a-zA-Z][\\w-]*\\b[^>]*\\bdata-doop-component\\s*=\\s*["']?${slug}(?![a-z0-9-])[^>]*>`,
  ).exec(html)
  if (!open || /\sdata-name\s*=/.test(open[0])) return html
  const safe = name.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const named = open[0].replace(/\s*(\/?)>$/, (end) => ` data-name="${safe}"${end.trim() === '/>' ? ' />' : '>'}`)
  return html.slice(0, open.index) + named + html.slice(open.index + open[0].length)
}

/** Points every instance of `from` at `to`. */
export function renameInstances(html: string, from: string, to: string): string {
  return html.replace(
    new RegExp(`(\\bdata-doop-component\\s*=\\s*["']?)${from}(?![a-z0-9-])`, 'g'),
    (_match, lead: string) => lead + to,
  )
}

/** What the stamp needs to know about a library. */
export interface StampSource {
  initialized: boolean
  globalCss: string
  components: ReadonlyMap<string, Pick<LibraryComponent, 'css' | 'js'>>
}

/* a block and the one newline written after it, so removing then
   re-inserting the same blocks gives back the same document */
const BLOCK_RE = /<(style|script)\b[^>]*\bdata-doop-library="([^"]+)"[^>]*>[\s\S]*?<\/\1\s*>\n?/gi
const TOKENS_KEY = 'tokens'
const cssKey = (slug: string) => `css:${slug}`
const jsKey = (slug: string) => `js:${slug}`

function styleBlock(key: string, css: string): string {
  return `<style data-doop-library="${key}">\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>\n`
}

/** Runs a component's script once the document is parsed, with `elements`
 *  bound to every instance in the frame. */
export function componentScript(slug: string, js: string): string {
  const selector = JSON.stringify(`[data-doop-component="${slug}"]`)
  return [
    '(function () {',
    '  var run = function () {',
    `    var elements = Array.prototype.slice.call(document.querySelectorAll(${selector}))`,
    js,
    '  }',
    "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run)",
    '  else run()',
    '})()',
  ].join('\n')
}

function scriptBlock(key: string, slug: string, js: string): string {
  return `<script data-doop-library="${key}">\n${componentScript(slug, js).replace(/<\/script/gi, '<\\/script')}\n</script>\n`
}

function usesTokens(html: string, globalCss: string): boolean {
  if (!html.includes('var(--')) return false
  return cssTokens(globalCss).some((token) => html.includes(`var(${token.name}`))
}

/** Inserts the blocks first in <head> (so a frame's own rules override
 *  them), else first in the document after its doctype. */
function insertBlocks(html: string, blocks: string): string {
  if (!blocks) return html
  const head = /<head\b[^>]*>/i.exec(html)
  if (head) {
    const at = head.index + head[0].length
    return `${html.slice(0, at)}${blocks}${html.slice(at)}`
  }
  const lead = /^\s*(<!doctype[^>]*>\s*)?(<html\b[^>]*>\s*)?/i.exec(html)?.[0] ?? ''
  return `${lead}${blocks}${html.slice(lead.length)}`
}

/**
 * Brings a frame's `data-doop-library` blocks in line with the library: the
 * CSS and JS of every component the frame uses, plus the global stylesheet
 * when the frame uses a component or one of its tokens. A component the
 * library no longer has keeps the block the frame already carried, so
 * deleting a component (or copying a canvas to another scope) never strips
 * the look off its instances. Returns the input unchanged when nothing moves.
 */
export function stampLibrary(html: string, source: StampSource): string {
  const hasBlocks = html.includes('data-doop-library')
  const hasInstances = html.includes('data-doop-component')
  if (!hasBlocks && !hasInstances && !(source.initialized && html.includes('var(--'))) return html

  const carried = new Map<string, string>()
  const body = html.replace(BLOCK_RE, (block: string, _tag: string, key: string) => {
    carried.set(key, block.endsWith('\n') ? block : `${block}\n`)
    return ''
  })
  const slugs = [...componentSlugsIn(body)].sort()

  let blocks = ''
  const tokensWanted = slugs.length > 0 || (source.initialized && usesTokens(body, source.globalCss))
  if (tokensWanted) {
    if (source.initialized) blocks += source.globalCss.trim() ? styleBlock(TOKENS_KEY, source.globalCss.trim()) : ''
    else blocks += carried.get(TOKENS_KEY) ?? ''
  }
  for (const slug of slugs) {
    const component = source.components.get(slug)
    if (!component) {
      blocks += (carried.get(cssKey(slug)) ?? '') + (carried.get(jsKey(slug)) ?? '')
      continue
    }
    if (component.css.trim()) blocks += styleBlock(cssKey(slug), component.css.trim())
    if (component.js.trim()) blocks += scriptBlock(jsKey(slug), slug, component.js.trim())
  }

  if (!hasBlocks && !blocks) return html
  const stamped = insertBlocks(body, blocks)
  return stamped === html ? html : stamped
}

function standaloneDocument(
  globalCss: string,
  component: Pick<LibraryComponent, 'slug' | 'css' | 'js'>,
  style: string,
  body: string,
) {
  const source: StampSource = {
    initialized: true,
    globalCss,
    components: new Map([[component.slug, component]]),
  }
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>${style}</style></head><body>${body}</body></html>`
  return stampLibrary(doc, source)
}

/** A standalone document showing a component (or a variant) for previews. */
export function previewDocument(
  globalCss: string,
  component: Pick<LibraryComponent, 'slug' | 'css' | 'js'>,
  markup: string,
) {
  return standaloneDocument(
    globalCss,
    component,
    'html,body{margin:0;height:100%}body{display:grid;place-items:center;padding:24px;box-sizing:border-box;background:var(--color-bg,#fff)}',
    markup,
  )
}

/** The attribute on the wrapper whose box `measureDocument` sizes. */
export const MEASURE_ATTRIBUTE = 'data-doop-measure'

/**
 * A standalone document for measuring an instance's natural size: the markup
 * inside a shrink-to-fit wrapper (inline style, so the global stylesheet's
 * own body rules cannot stretch it), styled like the frame it will land in.
 */
export function measureDocument(
  globalCss: string,
  component: Pick<LibraryComponent, 'slug' | 'css' | 'js'>,
  markup: string,
) {
  return standaloneDocument(
    globalCss,
    component,
    'html,body{margin:0}',
    `<div ${MEASURE_ATTRIBUTE} style="display:flow-root;width:max-content;max-width:100%;margin:0;padding:0;border:0">${markup}</div>`,
  )
}

export const DEFAULT_GLOBAL_CSS = `/* Global stylesheet: the tokens every component and frame builds on.
   Components keep only what is their own and read shared values from here. */
:root {
  /* colour */
  --color-bg: #ffffff;
  --color-surface: #f7f7f8;
  --color-surface-raised: #ffffff;
  --color-text: #111113;
  --color-text-muted: #5f6068;
  --color-border: #e2e2e6;
  --color-primary: #2743ee;
  --color-primary-hover: #1d34c4;
  --color-primary-contrast: #ffffff;
  --color-danger: #d0341f;
  --color-success: #0e9f6e;
  --color-warning: #c77800;
  --color-focus: rgba(39, 67, 238, 0.35);

  /* type */
  --font-sans: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-mono: ui-monospace, 'SF Mono', Menlo, monospace;
  --text-xs: 12px;
  --text-sm: 13px;
  --text-md: 15px;
  --text-lg: 18px;
  --text-xl: 24px;
  --weight-regular: 400;
  --weight-medium: 500;
  --weight-bold: 600;

  /* space and shape */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --radius-full: 999px;

  /* depth and motion */
  --shadow-sm: 0 1px 2px rgba(17, 17, 19, 0.06);
  --shadow-md: 0 4px 16px rgba(17, 17, 19, 0.08);
  --shadow-lg: 0 18px 48px rgba(17, 17, 19, 0.16);
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
  --duration: 160ms;
}

*, *::before, *::after { box-sizing: border-box; }
body { font-family: var(--font-sans); color: var(--color-text); }
:focus-visible { outline: 3px solid var(--color-focus); outline-offset: 2px; }
`
