/** One registry for inspector controls, validation, and sandbox inspection.
 * Values stay CSS values: percentages, variables and calc() survive edits. */
export interface DesignProperty {
  key: string
  label: string
  unit?: 'px' | 'deg'
  options?: string[]
  color?: boolean
  wide?: boolean
}

export interface DesignSection {
  id: string
  label: string
  open?: boolean
  fields: DesignProperty[]
}

const length = (key: string, label: string): DesignProperty => ({ key, label, unit: 'px' })
const choice = (key: string, label: string, options: string[]): DesignProperty => ({ key, label, options })
const color = (key: string, label: string): DesignProperty => ({ key, label, color: true, wide: true })

export const DESIGN_SECTIONS: DesignSection[] = [
  {
    id: 'position',
    label: 'Position',
    open: true,
    fields: [
      choice('position', 'Position', ['static', 'relative', 'absolute', 'fixed', 'sticky']),
      { key: 'z-index', label: 'Layer order' },
      length('left', 'Left'),
      length('top', 'Top'),
      length('right', 'Right'),
      length('bottom', 'Bottom'),
      { key: 'rotate', label: 'Rotation', unit: 'deg' },
      { key: 'scale', label: 'Scale' },
      { key: 'transform-origin', label: 'Transform origin', wide: true },
    ],
  },
  {
    id: 'size',
    label: 'Size',
    open: true,
    fields: [
      length('width', 'Width'),
      length('height', 'Height'),
      length('min-width', 'Min width'),
      length('max-width', 'Max width'),
      length('min-height', 'Min height'),
      length('max-height', 'Max height'),
      { key: 'aspect-ratio', label: 'Aspect ratio' },
      choice('box-sizing', 'Sizing', ['border-box', 'content-box']),
    ],
  },
  {
    id: 'layout',
    label: 'Auto layout',
    open: true,
    fields: [
      choice('display', 'Layout', [
        'block',
        'flex',
        'grid',
        'inline',
        'inline-block',
        'inline-flex',
        'inline-grid',
        'contents',
        'none',
      ]),
      choice('flex-direction', 'Direction', ['row', 'column', 'row-reverse', 'column-reverse']),
      choice('flex-wrap', 'Wrap', ['nowrap', 'wrap', 'wrap-reverse']),
      choice('justify-content', 'Distribute', [
        'normal',
        'flex-start',
        'center',
        'flex-end',
        'space-between',
        'space-around',
        'space-evenly',
      ]),
      choice('align-items', 'Align items', ['normal', 'stretch', 'flex-start', 'center', 'flex-end', 'baseline']),
      choice('align-self', 'Align self', ['auto', 'stretch', 'flex-start', 'center', 'flex-end', 'baseline']),
      length('column-gap', 'Column gap'),
      length('row-gap', 'Row gap'),
      { key: 'flex-grow', label: 'Grow' },
      { key: 'flex-shrink', label: 'Shrink' },
      length('flex-basis', 'Basis'),
      { key: 'order', label: 'Order' },
      { key: 'grid-template-columns', label: 'Grid columns', wide: true },
      { key: 'grid-template-rows', label: 'Grid rows', wide: true },
      { key: 'grid-column', label: 'Column span' },
      { key: 'grid-row', label: 'Row span' },
      choice('grid-auto-flow', 'Grid flow', ['row', 'column', 'row dense', 'column dense']),
      choice('justify-items', 'Grid alignment', ['normal', 'stretch', 'start', 'center', 'end']),
    ],
  },
  {
    id: 'spacing',
    label: 'Spacing',
    fields: [
      length('padding', 'Padding'),
      length('margin', 'Margin'),
      length('padding-top', 'Padding top'),
      length('padding-right', 'Padding right'),
      length('padding-bottom', 'Padding bottom'),
      length('padding-left', 'Padding left'),
      length('margin-top', 'Margin top'),
      length('margin-right', 'Margin right'),
      length('margin-bottom', 'Margin bottom'),
      length('margin-left', 'Margin left'),
    ],
  },
  {
    id: 'appearance',
    label: 'Appearance',
    open: true,
    fields: [
      { key: 'opacity', label: 'Opacity' },
      choice('mix-blend-mode', 'Blend', [
        'normal',
        'multiply',
        'screen',
        'overlay',
        'darken',
        'lighten',
        'color-dodge',
        'color-burn',
        'hard-light',
        'soft-light',
        'difference',
        'exclusion',
        'hue',
        'saturation',
        'color',
        'luminosity',
      ]),
      length('border-radius', 'Corner radius'),
      choice('overflow', 'Clip content', ['visible', 'hidden', 'clip', 'auto', 'scroll']),
      length('border-top-left-radius', 'Top left'),
      length('border-top-right-radius', 'Top right'),
      length('border-bottom-left-radius', 'Bottom left'),
      length('border-bottom-right-radius', 'Bottom right'),
      choice('visibility', 'Visibility', ['visible', 'hidden']),
      choice('isolation', 'Isolation', ['auto', 'isolate']),
    ],
  },
  {
    id: 'typography',
    label: 'Typography',
    open: true,
    fields: [
      { key: 'font-family', label: 'Font family', wide: true },
      { key: 'font-weight', label: 'Weight' },
      length('font-size', 'Font size'),
      { key: 'line-height', label: 'Line height' },
      length('letter-spacing', 'Letter spacing'),
      choice('font-style', 'Style', ['normal', 'italic', 'oblique']),
      choice('text-align', 'Text alignment', ['left', 'center', 'right', 'justify', 'start', 'end']),
      color('color', 'Text color'),
      choice('text-decoration-line', 'Decoration', [
        'none',
        'underline',
        'line-through',
        'overline',
        'underline line-through',
      ]),
      choice('text-transform', 'Case', ['none', 'uppercase', 'lowercase', 'capitalize']),
      choice('white-space', 'Text wrapping', ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces']),
      choice('text-wrap', 'Wrap style', ['wrap', 'nowrap', 'balance', 'pretty']),
    ],
  },
  {
    id: 'type-details',
    label: 'Type details',
    fields: [
      length('text-indent', 'Paragraph indent'),
      length('word-spacing', 'Word spacing'),
      choice('text-overflow', 'Truncation', ['clip', 'ellipsis']),
      choice('word-break', 'Word break', ['normal', 'break-all', 'keep-all']),
      choice('text-decoration-style', 'Underline style', ['solid', 'double', 'dotted', 'dashed', 'wavy']),
      length('text-decoration-thickness', 'Underline width'),
      length('text-underline-offset', 'Underline offset'),
      choice('text-decoration-skip-ink', 'Skip ink', ['auto', 'none', 'all']),
      color('text-decoration-color', 'Underline color'),
      choice('font-variant-caps', 'Small caps', ['normal', 'small-caps', 'all-small-caps', 'petite-caps', 'unicase']),
      choice('font-variant-position', 'Number position', ['normal', 'sub', 'super']),
      { key: 'font-variant-numeric', label: 'Number styles', wide: true },
      { key: 'font-feature-settings', label: 'OpenType features', wide: true },
      { key: 'font-variation-settings', label: 'Variable font axes', wide: true },
      choice('font-optical-sizing', 'Optical sizing', ['auto', 'none']),
      choice('list-style-type', 'List style', [
        'none',
        'disc',
        'circle',
        'square',
        'decimal',
        'lower-alpha',
        'upper-roman',
      ]),
      choice('list-style-position', 'List position', ['outside', 'inside']),
      { key: 'text-shadow', label: 'Text shadow', wide: true },
    ],
  },
  {
    id: 'fill',
    label: 'Fill',
    open: true,
    fields: [
      color('background-color', 'Fill color'),
      { key: 'background-size', label: 'Fill size' },
      { key: 'background-position', label: 'Fill position' },
      choice('background-repeat', 'Repeat', ['no-repeat', 'repeat', 'repeat-x', 'repeat-y', 'space', 'round']),
      choice('background-clip', 'Fill clip', ['border-box', 'padding-box', 'content-box', 'text']),
      { key: 'background-blend-mode', label: 'Fill blending', wide: true },
    ],
  },
  {
    id: 'stroke',
    label: 'Stroke',
    fields: [
      length('border-width', 'Stroke width'),
      choice('border-style', 'Stroke style', ['none', 'solid', 'dashed', 'dotted', 'double']),
      color('border-color', 'Stroke color'),
      length('border-top-width', 'Top stroke'),
      length('border-right-width', 'Right stroke'),
      length('border-bottom-width', 'Bottom stroke'),
      length('border-left-width', 'Left stroke'),
      { key: 'outline', label: 'Outside stroke', wide: true },
      length('outline-offset', 'Stroke offset'),
    ],
  },
  {
    id: 'effects',
    label: 'Effects',
    fields: [
      { key: 'filter', label: 'Layer filters', wide: true },
      { key: 'backdrop-filter', label: 'Background filters', wide: true },
    ],
  },
  {
    id: 'image',
    label: 'Image',
    open: true,
    fields: [
      choice('object-fit', 'Image fit', ['fill', 'contain', 'cover', 'none', 'scale-down']),
      { key: 'object-position', label: 'Image position' },
    ],
  },
  {
    id: 'vector',
    label: 'SVG appearance',
    open: true,
    fields: [
      color('fill', 'Vector fill'),
      color('stroke', 'Vector stroke'),
      length('stroke-width', 'Vector stroke width'),
      { key: 'stroke-dasharray', label: 'Dash pattern' },
      { key: 'stroke-dashoffset', label: 'Dash offset' },
      { key: 'stroke-miterlimit', label: 'Miter limit' },
      choice('stroke-linecap', 'Line cap', ['butt', 'round', 'square']),
      choice('stroke-linejoin', 'Line join', ['miter', 'round', 'bevel']),
      { key: 'fill-opacity', label: 'Fill opacity' },
      { key: 'stroke-opacity', label: 'Stroke opacity' },
      choice('fill-rule', 'Fill rule', ['nonzero', 'evenodd']),
    ],
  },
]

export const DESIGN_PROPERTIES = [
  ...DESIGN_SECTIONS.flatMap((section) => section.fields),
  { key: 'background-image', label: 'Fill layers', wide: true },
  { key: 'box-shadow', label: 'Shadows', wide: true },
  { key: 'transform', label: 'Transform', wide: true },
  { key: 'clip-path', label: 'Clip path', wide: true },
] satisfies DesignProperty[]

export const DESIGN_PROPERTY_KEYS = DESIGN_PROPERTIES.map((field) => field.key)

export function normalizeDesignValue(property: string, value: string): string {
  const trimmed = value.trim()
  const field = DESIGN_PROPERTIES.find((item) => item.key === property)
  if (!field) throw new Error('This property is not editable.')
  if (field.unit && /^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return `${trimmed}${field.unit}`
  return trimmed
}

/** CSS commas inside functions or quoted URLs do not separate layers. */
export function splitCssList(value: string): string[] {
  if (!value.trim() || value.trim() === 'none') return []
  const parts: string[] = []
  let start = 0
  let depth = 0
  let quote = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (quote) {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(value.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(value.slice(start).trim())
  return parts.filter(Boolean)
}
