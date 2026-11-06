import { useState } from 'react'
import { EXPORT_SCALE_PRESETS, formatExportScale, parseExportScale } from '../../shared/exportScale'
import type { ExportSettings } from '../lib/exportSettings'
import { FORMAT_LABEL, type FrameExportFormat } from '../lib/frameExport'
import { useT } from '../lib/i18n'
import { Input } from './ui/input'
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from './ui/select'

const FORMATS: readonly FrameExportFormat[] = ['png', 'jpg', 'svg']
/* the scale menu's own value for "type a multiplier"; never a preset's */
const CUSTOM = 'custom'

const isPreset = (scale: number) => (EXPORT_SCALE_PRESETS as readonly number[]).includes(scale)

/**
 * Figma's export row: a density (the presets or a typed multiplier) and a
 * format. An SVG has no density: the scale reads 1x and is set aside
 * while it is picked. Without `withFormat` it is the scale alone, for a
 * list whose rows are the formats.
 */
export function ExportOptions({
  value,
  onChange,
  withFormat = true,
}: {
  value: ExportSettings
  onChange: (patch: Partial<ExportSettings>) => void
  withFormat?: boolean
}) {
  const t = useT()
  /* picking Custom shows the field even while the scale is still a preset */
  const [typing, setTyping] = useState(false)
  const custom = typing || !isPreset(value.scale)
  const vector = withFormat && value.format === 'svg'

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
          <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label={t('panels.exportScale')}>
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
          <Select value={value.format} onValueChange={(next) => onChange({ format: next as FrameExportFormat })}>
            <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label={t('panels.exportFormat')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FORMATS.map((format) => (
                <SelectItem key={format} value={format}>
                  {FORMAT_LABEL[format]}
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
          variant="mono"
          inputSize="sm"
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
