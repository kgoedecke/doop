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
