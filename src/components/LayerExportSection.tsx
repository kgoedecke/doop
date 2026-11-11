import type { Frame } from '../../shared/types'
import { fitExportScale, formatExportScale } from '../../shared/exportScale'
import { trackExport, trackPngCopy } from '../lib/exportEvents'
import { setExportSettings, useExportSettings } from '../lib/exportSettings'
import { copyElementPng, downloadElementExport, type ElementTarget } from '../lib/frameExport'
import { useT } from '../lib/i18n'
import { cn } from '@/lib/utils'
import { ExportOptions } from './ExportOptions'
import { Button } from './ui/button'
import { DownloadIcon } from './ui/icons'
import { PropertySection } from './ui/property-field'

const actionClass =
  'h-7 w-full rounded-row bg-sub px-2 text-label font-normal text-ink hover:bg-paper-deep max-md:min-h-10'

/** The bottom of an element's Design tab, as Figma ends a layer's
 *  properties: the scale and format the frame Inspector shares, then this
 *  layer's export, cut from its frame as the canvas shows it. */
export function LayerExportSection({ frame, target }: { frame: Frame; target: ElementTarget }) {
  const t = useT()
  const settings = useExportSettings()
  return (
    <PropertySection title={t('inspector.groupExport')}>
      <div className="grid gap-1.5">
        <ExportOptions value={settings} onChange={setExportSettings} />
        <Button
          variant="bare"
          className={cn(actionClass, 'min-w-0 gap-1.5')}
          title={t('inspector.exportLayerTitle')}
          onClick={() => {
            trackExport(settings.format, 1, 'element_panel', 'element')
            void downloadElementExport(frame, target, settings.format, settings.scale)
          }}
        >
          <DownloadIcon className="size-3.5 flex-none" />
          <span className="truncate">{t('inspector.exportLayer', { name: target.name })}</span>
        </Button>
        <Button
          variant="bare"
          className={actionClass}
          title={t('inspector.copyPngTitle', { scale: formatExportScale(fitExportScale(frame, settings.scale)) })}
          onClick={() => {
            trackPngCopy('element', 'element_panel')
            void copyElementPng(frame, target, settings.scale)
          }}
        >
          {t('inspector.copyPng')}
        </Button>
      </div>
    </PropertySection>
  )
}
