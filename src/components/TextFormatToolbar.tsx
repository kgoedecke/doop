import { useT } from '../lib/i18n'
import type { TextFormatCommand, TextFormatState } from '../lib/richText'
import { Button } from './ui/button'
import { BoldIcon, ItalicIcon, UnderlineIcon, StrikethroughIcon, BulletListIcon, OrderedListIcon } from './ui/icons'

const formats = [
  { command: 'bold', label: 'textBold', Icon: BoldIcon },
  { command: 'italic', label: 'textItalic', Icon: ItalicIcon },
  { command: 'underline', label: 'textUnderline', Icon: UnderlineIcon },
  { command: 'strikeThrough', label: 'textStrikethrough', Icon: StrikethroughIcon },
  { command: 'insertUnorderedList', label: 'textBulletList', Icon: BulletListIcon },
  { command: 'insertOrderedList', label: 'textNumberedList', Icon: OrderedListIcon },
] as const

export function TextFormatToolbar({
  state,
  onFormat,
}: {
  state: TextFormatState
  onFormat: (command: TextFormatCommand) => void
}) {
  const t = useT()
  return (
    <div role="group" aria-label={t('stage.textFormatting')} className="flex items-center gap-0.5">
      {formats.map(({ command, label, Icon }) => (
        <Button
          key={command}
          variant="inverse"
          size="icon-sm"
          aria-label={t(`stage.${label}`)}
          title={t(`stage.${label}`)}
          aria-pressed={!!state[command]}
          className="aria-pressed:bg-paper/25"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onFormat(command)}
        >
          <Icon size="rail" />
        </Button>
      ))}
    </div>
  )
}
