/** Native editing commands shared by the iframe runtime and its toolbar. */
export const TEXT_FORMAT_COMMANDS = [
  'bold',
  'italic',
  'underline',
  'strikeThrough',
  'insertUnorderedList',
  'insertOrderedList',
] as const

export type TextFormatCommand = (typeof TEXT_FORMAT_COMMANDS)[number]
export type TextFormatState = Partial<Record<TextFormatCommand, boolean>>

/** Design panel text properties a selection inside an edited element scopes
 *  to its own runs; set on the whole layer, they override its runs. */
export const TEXT_STYLE_PROPERTIES = ['font-family', 'font-size', 'font-weight', 'color'] as const

/** The type a pasted look (⌥⌘V) carries from one text layer to another. It
 *  is read off the source's first text run, since ⌘B / ⌘I / ⌘U format a
 *  layer by wrapping its text in <b> / <i> / <u>, and it replaces the
 *  target's runs' own values, so the pasted type is what shows. */
export const LAYER_TEXT_PROPERTIES = [
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-transform',
  'text-decoration-line',
  'text-align',
] as const
