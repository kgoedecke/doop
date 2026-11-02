import { t, type PlainMessageKey } from './i18n'

/**
 * What the Layers panel calls an element nobody named. A tag says nothing to
 * a designer ("div"), so the name is built from what the element is and what
 * it holds: its role (from its tag, ARIA role or control type), else its one
 * meaningful class, else "Group" — followed by its context (an ARIA label,
 * the label of the field it wraps, the heading inside it, its first text):
 * "Card · Bancos", "Field · Número", "Row · 341", "Button · Edit".
 */

const MAX_CONTEXT = 40

const TAG_ROLES: Record<string, PlainMessageKey> = {
  HEADER: 'layers.header',
  NAV: 'layers.navigation',
  MAIN: 'layers.main',
  FOOTER: 'layers.footer',
  ASIDE: 'layers.sidebar',
  SECTION: 'layers.section',
  ARTICLE: 'layers.article',
  FORM: 'layers.form',
  FIELDSET: 'layers.fieldGroup',
  UL: 'layers.list',
  OL: 'layers.list',
  DL: 'layers.list',
  MENU: 'layers.menu',
  LI: 'layers.item',
  DT: 'layers.item',
  DD: 'layers.item',
  TABLE: 'layers.table',
  THEAD: 'layers.tableHeader',
  TBODY: 'layers.tableBody',
  TFOOT: 'layers.tableBody',
  TR: 'layers.row',
  TD: 'layers.cell',
  TH: 'layers.cell',
  BUTTON: 'layers.button',
  A: 'layers.link',
  SELECT: 'layers.select',
  TEXTAREA: 'layers.textArea',
  LABEL: 'layers.label',
  IMG: 'layers.image',
  PICTURE: 'layers.image',
  CANVAS: 'layers.image',
  VIDEO: 'layers.video',
  H1: 'layers.heading',
  H2: 'layers.heading',
  H3: 'layers.heading',
  H4: 'layers.heading',
  H5: 'layers.heading',
  H6: 'layers.heading',
  DIALOG: 'layers.dialog',
  FIGURE: 'layers.figure',
  BLOCKQUOTE: 'layers.quote',
  HR: 'layers.divider',
  IFRAME: 'layers.embed',
  DETAILS: 'layers.disclosure',
}

const ARIA_ROLES: Record<string, PlainMessageKey> = {
  button: 'layers.button',
  link: 'layers.link',
  navigation: 'layers.navigation',
  banner: 'layers.header',
  contentinfo: 'layers.footer',
  complementary: 'layers.sidebar',
  main: 'layers.main',
  dialog: 'layers.dialog',
  alertdialog: 'layers.dialog',
  alert: 'layers.alert',
  status: 'layers.alert',
  list: 'layers.list',
  listbox: 'layers.list',
  listitem: 'layers.item',
  option: 'layers.option',
  row: 'layers.row',
  cell: 'layers.cell',
  table: 'layers.table',
  tablist: 'layers.tabs',
  tab: 'layers.button',
  toolbar: 'layers.toolbar',
  menu: 'layers.menu',
  radiogroup: 'layers.fieldGroup',
  group: 'layers.group',
  img: 'layers.image',
  separator: 'layers.divider',
  heading: 'layers.heading',
  textbox: 'layers.textField',
  checkbox: 'layers.checkbox',
  switch: 'layers.checkbox',
}

const INPUT_ROLES: Record<string, PlainMessageKey> = {
  checkbox: 'layers.checkbox',
  radio: 'layers.option',
  submit: 'layers.button',
  button: 'layers.button',
  reset: 'layers.button',
  image: 'layers.button',
  range: 'layers.field',
  color: 'layers.field',
  file: 'layers.field',
  date: 'layers.field',
  time: 'layers.field',
}

/* layout and spacing helpers (UIkit, Tailwind, Bootstrap, the house ones)
   describe how an element sits, not what it is */
const UTILITY_CLASS =
  /^(uk-)?(margin|padding|width|height|text|flex|position|display|align|float|clearfix|visible|hidden|inline|overflow|border|background|box-shadow|light|dark|child-width|grid-(small|medium|large|collapse|match|divider)|first-column|link-(muted|text|reset|heading)|nav-(default|primary)|animation|transition|transform|cover|responsive|preserve|invisible|disabled|active|open)(-|$)|^(w|h|p|m|px|py|pt|pb|pl|pr|ps|pe|mx|my|mt|mb|ml|mr|ms|me|gap|space|bg|items|justify|content|self|place|rounded|shadow|font|leading|tracking|min|max|order|z|top|left|right|bottom|inset|col|row|d|g|fs|fw|lh|is|has|js)(-|$)|^(flex|grid|block|inline|relative|absolute|fixed|sticky|hidden|container|clearfix|truncate|uppercase|lowercase|capitalize|italic|underline|shrink|grow|sr-only|active|show|fade|in|out)$/

function clip(text: string, max = MAX_CONTEXT): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** "uk-card-header" -> "Card header", "cardPesquisa" -> "Card pesquisa". */
function humanizeClass(cls: string): string {
  const words = cls
    .replace(/^(uk|ds|js|c|o|u|l)-/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_\s]+/)
    .filter((word) => word && !/^\d+$/.test(word))
    .slice(0, 3)
    .join(' ')
    .toLowerCase()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : ''
}

/** The element's one class that names a thing rather than a layout tweak. */
export function meaningfulClass(el: Element): string | null {
  const classes = el.getAttribute('class')?.trim().split(/\s+/) ?? []
  for (const cls of classes) {
    if (!cls || UTILITY_CLASS.test(cls) || cls.includes(':') || cls.includes('@')) continue
    const label = humanizeClass(cls)
    if (label) return label
  }
  return null
}

function roleKey(el: Element): PlainMessageKey | null {
  const aria = el.getAttribute('role')?.trim().split(/\s+/)[0]
  if (aria && ARIA_ROLES[aria]) return ARIA_ROLES[aria]
  if (el.tagName === 'INPUT') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase()
    return type === 'hidden' ? null : (INPUT_ROLES[type] ?? 'layers.textField')
  }
  if (el.namespaceURI === 'http://www.w3.org/2000/svg')
    return el.closest('a, button, [role="button"]') ? 'layers.icon' : 'layers.vector'
  return TAG_ROLES[el.tagName] ?? null
}

const CONTROLS = 'input:not([type="hidden"]), select, textarea'

/** The text of the label that names a form control. */
function controlLabel(control: Element): string {
  const id = control.getAttribute('id')
  const doc = control.ownerDocument
  const byFor = id ? doc.querySelector(`label[for="${CSS.escape(id)}"]`) : null
  const wrapping = control.closest('label')
  const label = byFor ?? wrapping
  if (label) {
    const text = clip(label.textContent ?? '')
    if (text) return text
  }
  return clip(control.getAttribute('placeholder') ?? control.getAttribute('name') ?? '')
}

function firstText(el: Element): string {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement
    if (parent && (parent.closest('script, style, template') || parent.hasAttribute('hidden'))) continue
    const text = clip(node.nodeValue ?? '')
    if (text) return text
  }
  return ''
}

/** What the element is about: its ARIA label, the field it names or wraps,
 *  its heading, its first text. */
function contextOf(el: Element): string {
  const own = el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.getAttribute('alt')
  if (own?.trim()) return clip(own)
  if (el.matches(CONTROLS)) return controlLabel(el)
  if (el.namespaceURI === 'http://www.w3.org/2000/svg') return clip(el.querySelector('title')?.textContent ?? '')
  const field = fieldControl(el)
  if (field) {
    const label = controlLabel(field)
    if (label) return label
  }
  const heading = el.querySelector('h1, h2, h3, h4, h5, h6, legend, [class*="title"], [role="heading"]')
  if (heading) {
    const text = clip(heading.textContent ?? '')
    if (text) return text
  }
  return firstText(el)
}

/** The control of a field wrapper — a small box holding one form control
 *  (directly, or in a label it holds) and the text that names it — or null. */
function fieldControl(el: Element): Element | null {
  if (el.matches('form, fieldset, label') || el.matches(CONTROLS) || el.children.length > 3) return null
  const controls = el.querySelectorAll(CONTROLS)
  const control = controls.length === 1 ? controls[0]! : null
  if (!control) return null
  const parent = control.parentElement
  const close = parent === el || (parent?.tagName === 'LABEL' && parent.parentElement === el)
  return close ? control : null
}

const COUNTED = new Set(['UL', 'OL', 'DL', 'MENU', 'TBODY', 'SELECT'])

/** Three or more children cut from the same pattern (same tag, same first
 *  class): a collection, better told by its size than by its first text. */
function isCollection(el: Element): boolean {
  const children = [...el.children]
  if (children.length < 3 || el.querySelector('h1, h2, h3, h4, h5, h6, legend')) return false
  const shape = (child: Element) => `${child.tagName}.${child.getAttribute('class')?.trim().split(/\s+/)[0] ?? ''}`
  const first = shape(children[0]!)
  return children.every((child) => shape(child) === first)
}

/** The name a box, an image, a control or an icon shows when nobody named it. */
export function inferredLabel(el: Element): string {
  const key = roleKey(el)
  const classLabel = meaningfulClass(el)
  const isField = !key && fieldControl(el) !== null
  const base = key ? t(key) : isField ? t('layers.field') : (classLabel ?? t('layers.group'))

  if (!key && el.children.length === 0 && !(el.textContent ?? '').trim()) return classLabel ?? t('layers.spacer')

  if (COUNTED.has(el.tagName) || el.getAttribute('role') === 'list') {
    const count = el.tagName === 'SELECT' ? el.querySelectorAll('option').length : el.children.length
    const context = el.getAttribute('aria-label') ?? (el.tagName === 'SELECT' ? controlLabel(el) : '')
    return `${base} · ${context?.trim() ? clip(context) : t('layers.items', { count })}`
  }
  if (isCollection(el)) return `${base} · ${t('layers.items', { count: el.children.length })}`
  const context = contextOf(el)
  return context && context !== base ? `${base} · ${context}` : base
}

/** A text element's name: its text, led by its role when it has one that
 *  matters (a button, a link, a heading, a label). */
export function textLabel(el: Element, text: string): string {
  const key = roleKey(el)
  const shown = clip(text, 60)
  return key && key !== 'layers.cell' && key !== 'layers.item' ? `${t(key)} · ${shown}` : shown
}
