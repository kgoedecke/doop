/**
 * An SVG file becomes editable vector layers, the way Figma imports one:
 * every shape (`path`, `rect`, `circle`, `ellipse`, `line`, `polyline`,
 * `polygon`) is baked, transforms and all, into one `svg[data-doop-drawing="path"]`
 * the path editor opens; `<g>` nesting becomes groups; `<use>` is expanded;
 * fills, strokes, gradients and clips come along. Text and images stay as
 * they are, one layer each. The result is a standalone canvas element whose
 * layers are laid out in percentages of its shell, so resizing scales them.
 */
import {
  IDENTITY,
  apply,
  lengthScale,
  multiply,
  paddedBounds,
  parseLength,
  parseTransform,
  scaling,
  shapeToSubpaths,
  strokePad,
  subpathsData,
  transformSubpaths,
  translation,
  type Box,
  type Matrix,
  type Subpath,
  type Viewport,
} from './svgPath'

export interface ImportedSvg {
  html: string
  /** The intrinsic size of the content, in the file's px. */
  width: number
  height: number
  /** How many editable shapes, text and image layers the file gave. */
  layers: number
}

/** Where a shape's paint comes from: the browser's computed styles (so
 *  `<style>` rules, classes and `currentColor` resolve) or, without a
 *  layout, its own attributes with inheritance along the tree. */
export type StyleReader = (el: Element, property: string) => string

export interface ImportOptions {
  /** Prefix for the file's ids, so two imports in one document never share a gradient. */
  key?: string
  styles?: StyleReader
  /** `root` takes the file's own box (its width and height) as the element's
   *  box, the way an artboard is: a PDF page whose clipped backgrounds reach
   *  past its edges. Unset, the box is the union of what the file draws. */
  box?: 'content' | 'root'
  /** How many layers and how many elements to read before stopping (a PDF
   *  page's chart runs past the defaults an icon file never nears). */
  maxLayers?: number
  maxElements?: number
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'])
const GROUP_TAGS = new Set(['g', 'a', 'switch'])
const RAW_TAGS = new Set(['text', 'image'])
/** Elements that never render in place, only through a reference. */
const DEF_TAGS = new Set([
  'linearGradient',
  'radialGradient',
  'pattern',
  'clipPath',
  'mask',
  'filter',
  'marker',
  'symbol',
])
const SKIP_TAGS = new Set(['defs', 'title', 'desc', 'metadata', 'style', 'script', 'foreignObject', ...DEF_TAGS])
/** Expanding `<use>` and walking the tree stop here, so a hostile file cannot explode. */
const MAX_ELEMENTS = 4000
const MAX_LAYERS = 1500

const PAINT_PROPS = [
  'fill',
  'fill-rule',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
] as const
const TEXT_PROPS = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'text-anchor',
  'dominant-baseline',
  'text-decoration',
  'white-space',
] as const
const INHERITED = new Set<string>([...PAINT_PROPS, ...TEXT_PROPS, 'visibility', 'color'])
const DEFAULTS: Record<string, string> = {
  fill: 'black',
  'fill-rule': 'nonzero',
  'fill-opacity': '1',
  stroke: 'none',
  'stroke-width': '1',
  'stroke-linecap': 'butt',
  'stroke-linejoin': 'miter',
  'stroke-miterlimit': '4',
  'stroke-dasharray': 'none',
  'stroke-dashoffset': '0',
  'stroke-opacity': '1',
  opacity: '1',
  visibility: 'visible',
  display: 'inline',
  color: 'black',
  'stop-color': 'black',
  'stop-opacity': '1',
  'flood-color': 'black',
  'flood-opacity': '1',
  'lighting-color': 'white',
  transform: 'none',
  'transform-origin': '0 0',
  'clip-path': 'none',
  mask: 'none',
  filter: 'none',
}
/** The effects a text or image layer keeps from its stylesheet, since the
 *  written document has no stylesheet; its `<g>` wrapper carries the transform,
 *  so they stay in the element's own coordinates. */
const EFFECT_PROPS = ['clip-path', 'mask', 'filter'] as const
/** What a copied definition (a gradient stop, a clip's shape) keeps of its styles. */
const DEF_PROPS = [
  ...PAINT_PROPS,
  'stop-color',
  'stop-opacity',
  'flood-color',
  'flood-opacity',
  'lighting-color',
  'opacity',
  'transform',
] as const

/** The element's own declared value, from its `style` attribute or its presentation attribute. */
function declared(el: Element, property: string): string | null {
  const style = el.getAttribute('style')
  if (style) {
    const rule = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i').exec(style)
    if (rule?.[1]) return rule[1].trim()
  }
  const attribute = el.getAttribute(property)
  return attribute === null || attribute.trim() === '' ? null : attribute.trim()
}

/** Styles read from attributes alone: inherited properties come down the
 *  tree, `currentColor` resolves through `color`, class rules are not seen. */
export const attributeStyles: StyleReader = (el, property) => {
  for (let node: Element | null = el; node; node = INHERITED.has(property) ? node.parentElement : null) {
    const value = declared(node, property)
    if (value === null || value === 'inherit') continue
    return value === 'currentColor' ? attributeStyles(node, 'color') : value
  }
  return DEFAULTS[property] ?? ''
}

/** Styles as the browser computed them for a mounted tree. */
export const computedStyles: StyleReader = (el, property) => getComputedStyle(el).getPropertyValue(property).trim()

/* ---- reading the file ---- */

export function parseSvgMarkup(markup: string): SVGSVGElement | null {
  const xml = new DOMParser().parseFromString(markup, 'image/svg+xml')
  const root = xml.documentElement
  if (root && root.localName === 'svg' && !xml.querySelector('parsererror')) return root as unknown as SVGSVGElement
  /* not well-formed XML (an HTML entity, say): the HTML parser is forgiving */
  const html = new DOMParser().parseFromString(markup, 'text/html')
  const svg = html.querySelector('svg')
  return svg && svg.namespaceURI === SVG_NS ? svg : null
}

/** Does this text look like an SVG document, the way a copied file or snippet does? */
export function looksLikeSvg(text: string): boolean {
  const head = text.trimStart().slice(0, 512)
  return /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)
}

const UNITS: Record<string, number> = {
  px: 1,
  pt: 4 / 3,
  pc: 16,
  mm: 96 / 25.4,
  cm: 96 / 2.54,
  in: 96,
  em: 16,
  rem: 16,
}

function length(value: string | null): number | null {
  if (!value) return null
  const match = /^\s*([-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?)\s*([a-z%]*)\s*$/i.exec(value)
  if (!match) return null
  const number = Number(match[1])
  const unit = (match[2] ?? '').toLowerCase()
  if (unit === '%' || !Number.isFinite(number)) return null
  return number * (UNITS[unit] ?? 1)
}

function viewBoxOf(el: Element): Box | null {
  const numbers = (el.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  const [x, y, width, height] = numbers
  if (numbers.length !== 4 || !numbers.every(Number.isFinite) || width! <= 0 || height! <= 0) return null
  return { x: x!, y: y!, width: width!, height: height! }
}

/** The matrix that fits a viewBox into a viewport, honouring `preserveAspectRatio`. */
function viewBoxFit(viewBox: Box, viewport: Box, preserveAspectRatio: string | null): Matrix {
  const [align = 'xMidYMid', meetOrSlice = 'meet'] = (preserveAspectRatio?.trim() || 'xMidYMid').split(/\s+/)
  let sx = viewport.width / viewBox.width
  let sy = viewport.height / viewBox.height
  let tx = viewport.x
  let ty = viewport.y
  if (align !== 'none') {
    const scale = meetOrSlice === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy)
    sx = sy = scale
    const slackX = viewport.width - viewBox.width * scale
    const slackY = viewport.height - viewBox.height * scale
    tx += /xMid/i.test(align) ? slackX / 2 : /xMax/i.test(align) ? slackX : 0
    ty += /YMid/.test(align) ? slackY / 2 : /YMax/.test(align) ? slackY : 0
  }
  return multiply(multiply(translation(tx, ty), scaling(sx, sy)), translation(-viewBox.x, -viewBox.y))
}

/** The intrinsic size of the root: its width/height, else its viewBox, else the browser's 300×150. */
function rootSize(svg: Element): { width: number; height: number } {
  const viewBox = viewBoxOf(svg)
  const width = length(svg.getAttribute('width')) ?? viewBox?.width ?? 300
  const height = length(svg.getAttribute('height')) ?? viewBox?.height ?? 150
  return { width: Math.max(1, width), height: Math.max(1, height) }
}

/* ---- preparing the tree ---- */

/** Scripts, handlers and foreign content never come along; nothing of a
 *  file runs while it is read or after it lands. */
function sanitize(root: Element) {
  for (const el of [...root.querySelectorAll('script, foreignObject')]) el.remove()
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name)
    }
  }
}

/** An element by id within a subtree, whichever document it lives in. */
function byId(scope: Element, id: string): Element | null {
  for (const el of scope.querySelectorAll('[id]')) if (el.getAttribute('id') === id) return el
  return scope.getAttribute('id') === id ? scope : null
}

function hrefOf(el: Element): string | null {
  return (
    el.getAttribute('href') ??
    el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ??
    el.getAttribute('xlink:href')
  )
}

/** `<use>` becomes the element it points at, in place, with the use's
 *  position and inherited paint, so the walk sees ordinary shapes; a
 *  symbol becomes a nested svg sized by the use. */
function expandUses(root: Element, maxElements = MAX_ELEMENTS) {
  let budget = maxElements
  const stack: Element[] = []
  const expand = (use: Element, depth: number) => {
    const id = hrefOf(use)?.trim()
    const target = id?.startsWith('#') ? byId(root, id.slice(1)) : null
    if (!target || depth > 8 || stack.includes(target) || target.contains(use) || budget <= 0) {
      use.remove()
      return
    }
    const doc = use.ownerDocument
    const wrapper = doc.createElementNS(SVG_NS, 'g')
    for (const attr of [...use.attributes]) {
      if (!/^(href|xlink:href|x|y|width|height|transform)$/.test(attr.name)) wrapper.setAttribute(attr.name, attr.value)
    }
    const x = length(use.getAttribute('x')) ?? 0
    const y = length(use.getAttribute('y')) ?? 0
    const own = use.getAttribute('transform')
    const shift = x || y ? `translate(${x} ${y})` : ''
    if (own || shift) wrapper.setAttribute('transform', [own, shift].filter(Boolean).join(' '))
    let clone = target.cloneNode(true) as Element
    if (clone.localName === 'symbol') {
      const svg = doc.createElementNS(SVG_NS, 'svg')
      for (const attr of [...clone.attributes]) svg.setAttribute(attr.name, attr.value)
      while (clone.firstChild) svg.append(clone.firstChild)
      clone = svg
    }
    if (clone.localName === 'svg') {
      for (const name of ['width', 'height']) {
        const value = use.getAttribute(name)
        if (value) clone.setAttribute(name, value)
      }
    }
    for (const el of [clone, ...clone.querySelectorAll('[id]')]) el.removeAttribute('id')
    budget -= 1 + clone.querySelectorAll('*').length
    wrapper.append(clone)
    use.replaceWith(wrapper)
    stack.push(target)
    for (const nested of [...wrapper.querySelectorAll('use')]) expand(nested, depth + 1)
    stack.pop()
  }
  for (const use of [...root.querySelectorAll('use')]) if (root.contains(use)) expand(use, 0)
}

/* ---- walking the tree ---- */

interface Paint {
  values: Record<string, string>
  /** The element's own opacity, which groups keep as their own and shapes wear. */
  opacity: number
  mask: Reference | null
  filter: string | null
}

type Node =
  | {
      kind: 'group'
      name: string
      opacity: number
      clip: Reference | null
      mask: Reference | null
      filter: string | null
      children: Node[]
    }
  | {
      kind: 'shape'
      name: string
      subpaths: Subpath[]
      box: Box
      paint: Paint
      ctm: Matrix
      clip: Reference | null
    }
  | { kind: 'raw'; name: string; element: Element; ctm: Matrix; opacity: number }

/** A `url(#id)` reference baked at the transform of the element that used it. */
interface Reference {
  id: string
  ctm: Matrix
}

function referenceId(value: string): string | null {
  const match = /url\(\s*["']?#([^"')\s]+)["']?\s*\)/.exec(value)
  return match?.[1] ?? null
}

const TAG_NAMES: Record<string, string> = {
  path: 'Vector',
  rect: 'Rectangle',
  circle: 'Ellipse',
  ellipse: 'Ellipse',
  line: 'Line',
  polyline: 'Polyline',
  polygon: 'Polygon',
  text: 'Text',
  image: 'Image',
  g: 'Group',
  a: 'Group',
  switch: 'Group',
  svg: 'Group',
}

function nameOf(el: Element): string {
  const title = [...el.children].find((child) => child.localName === 'title')?.textContent?.trim()
  const id = el.getAttribute('id')?.trim()
  const label = el.getAttribute('aria-label')?.trim()
  return title || label || id || TAG_NAMES[el.localName] || el.localName
}

class Walker {
  layers = 0
  visited = 0
  constructor(
    private readonly read: StyleReader,
    /** The viewport a shape's percentages refer to: the nearest svg's viewBox. */
    private viewport: Viewport,
    private readonly maxLayers = MAX_LAYERS,
    private readonly maxElements = MAX_ELEMENTS,
  ) {}

  visit(el: Element, parentCtm: Matrix): Node | null {
    if (++this.visited > this.maxElements || this.layers >= this.maxLayers) return null
    const tag = el.localName
    if (el.namespaceURI !== SVG_NS || SKIP_TAGS.has(tag)) return null
    if (this.read(el, 'display') === 'none') return null
    const ctm = multiply(parentCtm, this.transformOf(el))
    if (tag === 'svg') {
      const outer = this.viewport
      this.viewport = viewBoxOf(el) ?? this.viewport
      const node = this.group(el, this.nestedSvg(el, ctm))
      this.viewport = outer
      return node
    }
    if (GROUP_TAGS.has(tag)) return this.group(el, ctm)
    if (SHAPE_TAGS.has(tag)) return this.shape(el, ctm)
    if (RAW_TAGS.has(tag)) return this.raw(el, ctm)
    return null
  }

  private nestedSvg(el: Element, ctm: Matrix): Matrix {
    const viewBox = viewBoxOf(el)
    const x = length(el.getAttribute('x')) ?? 0
    const y = length(el.getAttribute('y')) ?? 0
    const width = length(el.getAttribute('width')) ?? viewBox?.width ?? 0
    const height = length(el.getAttribute('height')) ?? viewBox?.height ?? 0
    if (!viewBox || !width || !height) return multiply(ctm, translation(x, y))
    return multiply(ctm, viewBoxFit(viewBox, { x, y, width, height }, el.getAttribute('preserveAspectRatio')))
  }

  /** The element's own transform as the styles resolve it (a stylesheet's
   *  `transform` overrides the attribute), about its `transform-origin`. */
  private transformOf(el: Element): Matrix {
    const resolved =
      parseTransform(this.read(el, 'transform')) ?? parseTransform(el.getAttribute('transform')) ?? IDENTITY
    const [ox = 0, oy = 0] = (this.read(el, 'transform-origin') || '0 0')
      .split(/\s+/)
      .map((part) => parseLength(part) ?? 0)
    if (!ox && !oy) return resolved
    return multiply(multiply(translation(ox, oy), resolved), translation(-ox, -oy))
  }

  /** A group's own effects, which the written group carries as a whole. */
  private effects(el: Element, ctm: Matrix) {
    const clip = referenceId(this.read(el, 'clip-path'))
    const mask = referenceId(this.read(el, 'mask'))
    return {
      opacity: opacityOf(this.read(el, 'opacity')),
      clip: clip ? { id: clip, ctm } : null,
      mask: mask ? { id: mask, ctm } : null,
      filter: referenceId(this.read(el, 'filter')),
    }
  }

  group(el: Element, ctm: Matrix): Node | null {
    const children: Node[] = []
    for (const child of el.children) {
      const node = this.visit(child, ctm)
      if (node) children.push(node)
    }
    if (!children.length) return null
    return { kind: 'group', name: nameOf(el), ...this.effects(el, ctm), children }
  }

  private shape(el: Element, ctm: Matrix): Node | null {
    const local = shapeToSubpaths(el, this.viewport)
    if (!local || this.read(el, 'visibility') === 'hidden') return null
    const subpaths = transformSubpaths(local, ctm)
    const scale = lengthScale(ctm)
    const values: Record<string, string> = {}
    for (const property of PAINT_PROPS) values[property] = this.read(el, property)
    values['stroke-width'] = String(round((parseFloat(values['stroke-width'] ?? '1') || 0) * scale))
    if (values['stroke-dasharray'] && values['stroke-dasharray'] !== 'none') {
      values['stroke-dasharray'] = values['stroke-dasharray']
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((part) => round((parseFloat(part) || 0) * scale))
        .join(' ')
    }
    values['stroke-dashoffset'] = String(round((parseFloat(values['stroke-dashoffset'] ?? '0') || 0) * scale))
    const stroke = values['stroke'] !== 'none' ? parseFloat(values['stroke-width'] ?? '0') || 0 : 0
    const clip = referenceId(this.read(el, 'clip-path'))
    const mask = referenceId(this.read(el, 'mask'))
    this.layers++
    return {
      kind: 'shape',
      name: nameOf(el),
      subpaths,
      box: paddedBounds(subpaths, strokePad(stroke)),
      paint: {
        values,
        opacity: opacityOf(this.read(el, 'opacity')),
        mask: mask ? { id: mask, ctm } : null,
        filter: referenceId(this.read(el, 'filter')),
      },
      ctm,
      clip: clip ? { id: clip, ctm } : null,
    }
  }

  private raw(el: Element, ctm: Matrix): Node | null {
    if (this.read(el, 'visibility') === 'hidden') return null
    const element = el.cloneNode(true) as Element
    element.removeAttribute('transform')
    element.removeAttribute('id')
    /* the layer's svg wears the opacity; left on the element too, it would apply twice */
    element.removeAttribute('opacity')
    ;(element as HTMLElement).style.removeProperty('opacity')
    if (!element.getAttribute('style')) element.removeAttribute('style')
    bakeStyles(element, el, this.read, [...PAINT_PROPS, ...TEXT_PROPS, ...EFFECT_PROPS])
    this.layers++
    return { kind: 'raw', name: nameOf(el), element, ctm, opacity: opacityOf(this.read(el, 'opacity')) }
  }
}

/** A clone keeps the styles its original resolved, written inline, so a
 *  class rule or inherited fill survives leaving the file's tree; children
 *  are paired by position. */
function bakeStyles(clone: Element, original: Element, read: StyleReader, properties: readonly string[]) {
  const style: string[] = []
  for (const property of properties) {
    const value = read(original, property)
    if (value && value !== DEFAULTS[property]) style.push(`${property}:${value}`)
  }
  if (style.length) clone.setAttribute('style', style.join(';'))
  const originals = [...original.children]
  ;[...clone.children].forEach((child, index) => {
    const source = originals[index]
    if (source) bakeStyles(child, source, read, properties)
  })
}

/** The box an element's `x`/`y`/`width`/`height` name, as the transform lands
 *  it (the box around the moved corners); `null` when any side is missing or
 *  relative (a percentage, an `em`), since those resolve against something the
 *  copy keeps and are left as written. */
function transformedBounds(el: Element, ctm: Matrix): Box | null {
  const side = (name: string) => {
    const value = el.getAttribute(name)
    return value && /^\s*[-+.\d]+(?:[eE][-+]?\d+)?\s*(?:px|pt|pc|mm|cm|in)?\s*$/.test(value) ? parseLength(value) : null
  }
  const x = side('x')
  const y = side('y')
  const width = side('width')
  const height = side('height')
  if (x === null || y === null || width === null || height === null) return null
  const corners = [
    { x, y },
    { x: x + width, y },
    { x, y: y + height },
    { x: x + width, y: y + height },
  ].map((corner) => apply(ctm, corner))
  const xs = corners.map((p) => p.x)
  const ys = corners.map((p) => p.y)
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top }
}

function opacityOf(value: string): number {
  const number = parseFloat(value)
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 1
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/* ---- the content box ---- */

function union(a: Box | null, b: Box): Box {
  if (!a) return b
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  }
}

function contentBox(nodes: Node[], root: Box): Box | null {
  let box: Box | null = null
  const visit = (node: Node) => {
    if (node.kind === 'shape') box = union(box, node.box)
    else if (node.kind === 'raw') box = union(box, root)
    else node.children.forEach(visit)
  }
  nodes.forEach(visit)
  return box
}

/** Groups with one child collapse, as the file's wrapper `<g>`s would otherwise
 *  nest a single icon three deep. */
function unwrap(nodes: Node[]): Node[] {
  return nodes.map((node) => {
    if (node.kind !== 'group') return node
    const children = unwrap(node.children)
    const only = children[0]
    if (children.length === 1 && only && node.opacity === 1 && !node.clip && !node.mask && !node.filter) return only
    return { ...node, children }
  })
}

/* ---- writing the element ---- */

class Writer {
  private readonly doc: Document
  private clipCount = 0
  private maskCount = 0
  readonly defs: Element
  readonly gradientCopies = new Map<string, string>()
  /** Every id the file declared, plus the copies made here: what gets the prefix. */
  private readonly ids = new Set<string>()

  constructor(
    private readonly source: Element,
    private readonly content: Box,
    private readonly key: string,
    read: StyleReader,
  ) {
    this.doc = new DOMParser().parseFromString('<!doctype html><html><head></head><body></body></html>', 'text/html')
    this.defs = this.doc.createElementNS(SVG_NS, 'defs')
    for (const el of source.querySelectorAll([...DEF_TAGS].join(','))) {
      if (el.parentElement && DEF_TAGS.has(el.parentElement.localName)) continue
      /* a stop coloured by a class keeps that colour once the stylesheet is gone */
      const copy = this.doc.importNode(el, true)
      bakeStyles(copy, el, read, DEF_PROPS)
      this.defs.append(copy)
    }
    for (const el of source.querySelectorAll('[id]')) this.ids.add(el.getAttribute('id')!)
  }

  document(nodes: Node[], name: string): string {
    const doc = this.doc
    doc.documentElement.style.cssText = 'width:100%;height:100%;margin:0;'
    doc.body.style.cssText = 'width:100%;height:100%;margin:0;'
    doc.body.setAttribute('data-doop-canvas-element', 'true')
    const only = nodes[0]
    if (nodes.length === 1 && only?.kind === 'shape') {
      const svg = this.shape(only, true)
      svg.setAttribute('data-name', name)
      if (this.defs.childElementCount) svg.prepend(this.defs)
      doc.body.append(svg)
    } else {
      /* a file wrapped in one group is that group, under the file's name */
      const root = this.group(
        nodes.length === 1 && only?.kind === 'group'
          ? { ...only, name }
          : { kind: 'group', name, opacity: 1, clip: null, mask: null, filter: null, children: nodes },
      )
      if (this.defs.childElementCount) {
        const host = doc.createElementNS(SVG_NS, 'svg')
        host.setAttribute('data-doop-defs', '')
        host.setAttribute('aria-hidden', 'true')
        host.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden;')
        host.append(this.defs)
        root.prepend(host)
      }
      doc.body.append(root)
    }
    return this.prefixIds('<!doctype html>\n' + doc.documentElement.outerHTML)
  }

  private node(node: Node): Element {
    if (node.kind === 'group') return this.group(node)
    if (node.kind === 'shape') return this.shape(node, false)
    return this.raw(node)
  }

  private group(node: Extract<Node, { kind: 'group' }>): HTMLElement {
    const div = this.doc.createElement('div')
    div.setAttribute('data-doop-drawing', 'group')
    div.setAttribute('data-name', node.name)
    let style = 'position:absolute;left:0;top:0;width:100%;height:100%;margin:0;'
    if (node.opacity !== 1) style += `opacity:${node.opacity};`
    if (node.clip) {
      /* the div's origin is the content box's corner, the shapes' is the file's */
      const id = this.bakedClip(node.clip, multiply(translation(-this.content.x, -this.content.y), node.clip.ctm))
      if (id) style += `clip-path:url(#${id});`
    }
    if (node.mask) {
      const id = this.bakedMask(node.mask, multiply(translation(-this.content.x, -this.content.y), node.mask.ctm))
      if (id) style += `mask:url(#${id});`
    }
    if (node.filter) style += `filter:url(#${node.filter});`
    div.setAttribute('style', style)
    for (const child of node.children) div.append(this.node(child))
    return div
  }

  private shape(node: Extract<Node, { kind: 'shape' }>, root: boolean): SVGSVGElement {
    const svg = this.doc.createElementNS(SVG_NS, 'svg') as SVGSVGElement
    svg.setAttribute('data-doop-drawing', 'path')
    svg.setAttribute('data-name', node.name)
    const { box } = node
    svg.setAttribute('viewBox', `${round(box.x)} ${round(box.y)} ${round(box.width)} ${round(box.height)}`)
    svg.setAttribute('preserveAspectRatio', 'none')
    svg.setAttribute('style', `${this.placement(box, root)}overflow:visible;box-sizing:border-box;margin:0;`)
    if (node.paint.opacity !== 1) svg.setAttribute('opacity', String(node.paint.opacity))
    const path = this.doc.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', subpathsData(node.subpaths))
    for (const property of PAINT_PROPS) {
      const value = node.paint.values[property]
      if (value && value !== DEFAULTS[property]) path.setAttribute(property, this.bakedPaint(value, node.ctm))
    }
    if (node.clip) {
      const id = this.bakedClip(node.clip, node.clip.ctm)
      if (id) path.setAttribute('clip-path', `url(#${id})`)
    }
    if (node.paint.mask) {
      const id = this.bakedMask(node.paint.mask, node.paint.mask.ctm)
      if (id) path.setAttribute('mask', `url(#${id})`)
    }
    if (node.paint.filter) path.setAttribute('filter', `url(#${node.paint.filter})`)
    svg.append(path)
    return svg
  }

  private raw(node: Extract<Node, { kind: 'raw' }>): SVGSVGElement {
    const svg = this.doc.createElementNS(SVG_NS, 'svg') as SVGSVGElement
    svg.setAttribute('data-doop-drawing', 'svg')
    svg.setAttribute('data-name', node.name)
    const { content } = this
    svg.setAttribute(
      'viewBox',
      `${round(content.x)} ${round(content.y)} ${round(content.width)} ${round(content.height)}`,
    )
    svg.setAttribute('preserveAspectRatio', 'none')
    svg.setAttribute(
      'style',
      'position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;box-sizing:border-box;margin:0;',
    )
    if (node.opacity !== 1) svg.setAttribute('opacity', String(node.opacity))
    const g = this.doc.createElementNS(SVG_NS, 'g')
    g.setAttribute('transform', `matrix(${node.ctm.map(round).join(' ')})`)
    g.append(this.doc.importNode(node.element, true))
    svg.append(g)
    return svg
  }

  /** A layer's place in percentages of the shell, so the shell's grips scale it. */
  private placement(box: Box, root: boolean): string {
    if (root) return 'position:absolute;left:0;top:0;width:100%;height:100%;'
    const { content } = this
    const pct = (value: number) => `${round(value * 100)}%`
    return `position:absolute;left:${pct((box.x - content.x) / content.width)};top:${pct((box.y - content.y) / content.height)};width:${pct(box.width / content.width)};height:${pct(box.height / content.height)};`
  }

  /** A gradient in user units is anchored to the file's coordinates; a copy
   *  with the shape's transform folded in keeps it on the baked shape. */
  private bakedPaint(value: string, ctm: Matrix): string {
    const id = referenceId(value)
    if (!id) return value
    const gradient = this.find(id)
    if (
      !gradient ||
      !/Gradient$/.test(gradient.localName) ||
      gradient.getAttribute('gradientUnits') !== 'userSpaceOnUse'
    )
      return value
    const copyKey = `${id}@${ctm.map(round).join(',')}`
    let copy = this.gradientCopies.get(copyKey)
    if (!copy) {
      copy = `${id}-baked-${this.gradientCopies.size + 1}`
      const clone = gradient.cloneNode(true) as Element
      clone.setAttribute('id', copy)
      this.ids.add(copy)
      const existing = parseTransform(gradient.getAttribute('gradientTransform')) ?? IDENTITY
      clone.setAttribute('gradientTransform', `matrix(${multiply(ctm, existing).map(round).join(' ')})`)
      this.defs.append(clone)
      this.gradientCopies.set(copyKey, copy)
    }
    return value.replace(/url\([^)]*\)/, `url(#${copy})`)
  }

  /** A clip in user units gets a copy carrying the clipped element's transform. */
  private bakedClip(reference: Reference, ctm: Matrix): string | null {
    const clip = this.find(reference.id)
    if (!clip || clip.localName !== 'clipPath') return null
    if (clip.getAttribute('clipPathUnits') === 'objectBoundingBox') return reference.id
    const copy = `${reference.id}-clip-${++this.clipCount}`
    const clone = clip.cloneNode(true) as Element
    clone.setAttribute('id', copy)
    this.ids.add(copy)
    /* the clip's own transform, as the styles resolved it (baked inline on the
       copy) or as its attribute says; the combined one goes on the attribute
       alone, since an inline value would win over it */
    const style = (clone as HTMLElement).style
    const existing = parseTransform(style.transform || clip.getAttribute('transform')) ?? IDENTITY
    style.removeProperty('transform')
    if (!clone.getAttribute('style')) clone.removeAttribute('style')
    clone.setAttribute('transform', `matrix(${multiply(ctm, existing).map(round).join(' ')})`)
    this.defs.append(clone)
    return copy
  }

  /** A mask in user units gets a copy carrying the masked element's transform:
   *  its content in a `<g>` (since `<mask>` itself takes none) and its bounds
   *  moved to where they land. One wholly in the element's bounding box is
   *  used as it is. */
  private bakedMask(reference: Reference, ctm: Matrix): string | null {
    const mask = this.find(reference.id)
    if (!mask || mask.localName !== 'mask') return null
    const userBounds = mask.getAttribute('maskUnits') === 'userSpaceOnUse'
    const userContent = mask.getAttribute('maskContentUnits') !== 'objectBoundingBox'
    if (!userBounds && !userContent) return reference.id
    const copy = `${reference.id}-mask-${++this.maskCount}`
    const clone = mask.cloneNode(true) as Element
    clone.setAttribute('id', copy)
    this.ids.add(copy)
    if (userContent) {
      const content = this.doc.createElementNS(SVG_NS, 'g')
      content.setAttribute('transform', `matrix(${ctm.map(round).join(' ')})`)
      content.append(...clone.childNodes)
      clone.append(content)
    }
    if (userBounds) {
      const bounds = transformedBounds(clone, ctm)
      if (bounds) for (const [name, value] of Object.entries(bounds)) clone.setAttribute(name, String(round(value)))
    }
    this.defs.append(clone)
    return copy
  }

  private find(id: string): Element | null {
    return byId(this.defs, id) ?? byId(this.source, id)
  }

  /** Every id the file declared gets the import's prefix, references included. */
  private prefixIds(html: string): string {
    const prefix = (id: string) => (this.ids.has(id) ? `${this.key}-${id}` : id)
    return html
      .replace(/url\(\s*(?:&quot;|["'])?#([^"'&)\s]+)(?:&quot;|["'])?\s*\)/g, (_, id: string) => `url(#${prefix(id)})`)
      .replace(/\b(xlink:href|href)="#([^"]+)"/g, (_, name: string, id: string) => `${name}="#${prefix(id)}"`)
      .replace(/\bid="([^"]+)"/g, (_, id: string) => `id="${prefix(id)}"`)
  }
}

/* ---- the entry points ---- */

/** Read one SVG document into a standalone canvas element. `null` when the
 *  markup is not SVG or draws nothing an element could hold. */
export function importSvg(root: SVGSVGElement, name: string, options: ImportOptions = {}): ImportedSvg | null {
  const read = options.styles ?? attributeStyles
  const key = options.key ?? `svg${Math.random().toString(36).slice(2, 8)}`
  const size = rootSize(root)
  const viewBox = viewBoxOf(root) ?? { x: 0, y: 0, ...size }
  const rootCtm = viewBoxFit(viewBox, { x: 0, y: 0, ...size }, root.getAttribute('preserveAspectRatio'))
  if (read(root, 'display') === 'none') return null
  const walker = new Walker(read, viewBox, options.maxLayers, options.maxElements)
  /* the root's own effects (an opacity, a clip, a transform) belong to the
     whole: it is walked as the group it is */
  const whole = walker.group(root, multiply(walker['transformOf'](root), rootCtm))
  if (!whole) return null
  const unwrapped = unwrap([whole])
  const content = options.box === 'root' ? { x: 0, y: 0, ...size } : contentBox(unwrapped, { x: 0, y: 0, ...size })
  if (!content || content.width <= 0 || content.height <= 0) return null
  const html = new Writer(root, content, key, read).document(unwrapped, name)
  return { html, width: content.width, height: content.height, layers: walker.layers }
}

/** Parse markup and import it with its own attributes as the styles. */
export function importSvgMarkup(markup: string, name: string, options: ImportOptions = {}): ImportedSvg | null {
  const root = parseSvgMarkup(markup)
  if (!root) return null
  sanitize(root)
  expandUses(root, options.maxElements)
  return importSvg(root, name, options)
}

/** In a browser: mount the file out of sight, inside a shadow root so its
 *  `<style>` reaches nothing else, and read the styles the engine computed. */
export function importSvgInBrowser(markup: string, name: string, options: ImportOptions = {}): ImportedSvg | null {
  const parsed = parseSvgMarkup(markup)
  if (!parsed) return null
  sanitize(parsed)
  expandUses(parsed, options.maxElements)
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  /* out of sight without `visibility`, which would inherit into the file and hide every shape */
  host.style.cssText = 'position:fixed;left:-100000px;top:0;opacity:0;pointer-events:none;contain:strict;'
  const shadow = host.attachShadow({ mode: 'closed' })
  const root = document.importNode(parsed, true) as unknown as SVGSVGElement
  shadow.append(root)
  document.body.append(host)
  try {
    return importSvg(root, name, { ...options, styles: options.styles ?? computedStyles })
  } finally {
    host.remove()
  }
}
