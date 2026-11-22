import { useState } from 'react'
import { EXPORT_SCALE_PRESETS, formatExportScale, parseExportScale } from '../../shared/exportScale'
import type { ExportPickFormat, ExportSettings } from '../lib/exportSettings'
import { useT } from '../lib/i18n'
import { Input } from './ui/input'
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from './ui/select'

/** A layer's formats; a whole frame adds PDF. */
export const IMAGE_FORMATS: readonly ExportPickFormat[] = ['png', 'jpg', 'svg']
export const FRAME_FORMATS: readonly ExportPickFormat[] = [...IMAGE_FORMATS, 'pdf']

const FORMAT_LABEL: Record<ExportPickFormat, string> = { png: 'PNG', jpg: 'JPG', svg: 'SVG', pdf: 'PDF' }

/* vector files have no pixel density */
const isVector = (format: ExportPickFormat) => format === 'svg' || format === 'pdf'
/* the scale menu's own value for "type a multiplier"; never a preset's */
const CUSTOM = 'custom'

const isPreset = (scale: number) => (EXPORT_SCALE_PRESETS as readonly number[]).includes(scale)

/**
 * Figma's export row: a density (the presets or a typed multiplier) and a
 * format. An SVG or PDF has no density: the scale reads 1x and is set
 * aside while it is picked. Without `withFormat` it is the scale alone, for
 * a list whose rows are the formats. A pick `formats` lacks (a PDF, in a
 * layer's menu) shows as the first of them, which is what that export uses.
 */
export function ExportOptions({
  value,
  onChange,
  withFormat = true,
  formats = IMAGE_FORMATS,
  compact = false,
}: {
  value: ExportSettings
  onChange: (patch: Partial<ExportSettings>) => void
  withFormat?: boolean
  /** the formats offered; PDF only where a whole frame exports */
  formats?: readonly ExportPickFormat[]
  /** the Inspector's 26px property wells instead of the modal's ring controls */
  compact?: boolean
}) {
  const triggerSize = compact ? 'field' : 'sm'
  const t = useT()
  /* picking Custom shows the field even while the scale is still a preset */
  const [typing, setTyping] = useState(false)
  const custom = typing || !isPreset(value.scale)
  const format = formats.includes(value.format) ? value.format : (formats[0] ?? 'png')
  const vector = withFormat && isVector(format)

  /** A readable multiplier is the scale; anything else puts the field back
   *  to the scale exports use, so it never shows one they ignore. */
  function commitCustom(field: HTMLInputElement) {
    const scale = parseExportScale(field.value)
    if (scale === null) field.value = String(value.scale)
    else if (scale !== value.scale) onChange({ scale })
    else field.value = String(scale)
  }

  return (
    <div className="grid gap-1.5">
      <div className="flex gap-1.5">
        <Select
          value={custom ? CUSTOM : String(value.scale)}
          disabled={vector}
          onValueChange={(next) => {
            if (next === CUSTOM) return setTyping(true)
            setTyping(false)
            onChange({ scale: Number(next) })
          }}
        >
          <SelectTrigger size={triggerSize} className="min-w-0 flex-1" aria-label={t('panels.exportScale')}>
            <SelectValue>{formatExportScale(vector ? 1 : value.scale)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {EXPORT_SCALE_PRESETS.map((scale) => (
              <SelectItem key={scale} value={String(scale)}>
                {formatExportScale(scale)}
              </SelectItem>
            ))}
            <SelectSeparator />
            <SelectItem value={CUSTOM}>{t('panels.exportScaleCustom')}</SelectItem>
          </SelectContent>
        </Select>
        {withFormat && (
          <Select value={format} onValueChange={(next) => onChange({ format: next as ExportPickFormat })}>
            <SelectTrigger size={triggerSize} className="min-w-0 flex-1" aria-label={t('panels.exportFormat')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {formats.map((option) => (
                <SelectItem key={option} value={option}>
                  {FORMAT_LABEL[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {custom && !vector && (
        <Input
          /* a new committed scale resets what the field shows */
          key={value.scale}
          variant={compact ? 'field' : 'mono'}
          inputSize={compact ? 'auto' : 'sm'}
          inputMode="decimal"
          defaultValue={String(value.scale)}
          aria-label={t('panels.exportScaleCustomLabel')}
          placeholder="1.5"
          onBlur={(e) => commitCustom(e.currentTarget)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitCustom(e.currentTarget)
          }}
        />
      )}
    </div>
  )
}
