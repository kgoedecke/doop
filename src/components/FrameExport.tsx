import { useEffect, useRef, useState } from 'react'
import {
  EXPORT_SCALES,
  exportDimensions,
  clipExportRegion,
  exportSelectionBounds,
  exportFileNames,
  exportSizeError,
  type ExportFormat,
  type ExportRect,
  type ExportScale,
} from '../../shared/frameExport'
import { downloadExport, prepareFrameExport } from '../lib/frameExport'
import { useStore } from '../lib/store'
import { Button } from './ui/button'
import { Field } from './ui/field'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'

export function FrameExport() {
  const ids = useStore((s) => s.exportFrameIds)
  return ids ? <ExportDialog key={ids.join(',')} ids={ids} /> : null
}

const selectClass =
  'h-10 w-full rounded-md border border-line bg-surface px-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40'

function ExportDialog({ ids }: { ids: string[] }) {
  const close = useStore((s) => s.closeExport)
  const [frames] = useState(() => useStore.getState().canvas?.frames.filter((f) => ids.includes(f.id)) ?? [])
  const [element] = useState(() => useStore.getState().exportElement)
  const [scope, setScope] = useState<'element' | 'frame'>(element ? 'element' : 'frame')
  const [format, setFormat] = useState<ExportFormat>('png')
  const [scale, setScale] = useState<ExportScale>(2)
  const [mode, setMode] = useState<'separate' | 'combined'>('separate')
  const [quality, setQuality] = useState(90)
  const [busy, setBusy] = useState(false)
  const [completed, setCompleted] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  let crop: ExportRect | undefined
  let cropError: string | null = null
  if (scope === 'element' && element && frames[0]) {
    try {
      crop = clipExportRegion(frames[0], element.rect)
    } catch (e) {
      cropError = e instanceof Error ? e.message : 'Invalid export region.'
    }
  }
  const exportFrames = crop ? frames.map((frame) => ({ ...frame, name: `${frame.name} - ${element!.label}` })) : frames
  const names = exportFileNames(exportFrames, format)
  const tooLarge = frames.find((f) => exportSizeError(crop ?? f, scale))
  const combined = mode === 'combined' && frames.length > 1
  const bounds = exportSelectionBounds(frames)
  const combinedSize = exportDimensions(bounds, scale)
  const sizeError =
    (combined && exportSizeError(bounds, scale)) ||
    (tooLarge ? `${tooLarge.name}: ${exportSizeError(crop ?? tooLarge, scale)}` : null)
  const selectionError =
    cropError ||
    (!frames.length
      ? 'Select at least one frame to export.'
      : frames.length > 100
        ? 'Export up to 100 frames at a time.'
        : null)

  async function startExport() {
    if (controller.current) return
    const run = new AbortController()
    controller.current = run
    setBusy(true)
    setCompleted(0)
    setError(null)
    try {
      const file = await prepareFrameExport(
        exportFrames,
        { format, scale, quality, mode, crop },
        run.signal,
        setCompleted,
      )
      if (run.signal.aborted) return
      downloadExport(file.blob, file.name)
      close()
    } catch (e) {
      if (!run.signal.aborted) setError(e instanceof Error ? e.message : 'Export failed. Please retry.')
    } finally {
      if (!run.signal.aborted) {
        controller.current = null
        setBusy(false)
      }
    }
  }

  return (
    <Modal
      size="md"
      onClose={close}
      onKeyDown={(e) => e.stopPropagation()}
      onEscapeKeyDown={(e) => {
        // Radix dismisses on document capture; keep this Escape from reaching
        // canvas shortcuts after the dialog has unmounted.
        e.preventDefault()
        e.stopPropagation()
        close()
      }}
    >
      <ModalTitle>
        {scope === 'element' ? 'Export element' : frames.length === 1 ? 'Export frame' : 'Export selection'}
      </ModalTitle>
      <ModalLede>
        {element
          ? 'Crop the selected element as it appears in the frame, or export the whole frame.'
          : frames.length === 1
            ? 'Download an image at the size you need.'
            : 'Export each frame separately or keep their canvas layout in one image.'}
      </ModalLede>
      <fieldset disabled={busy} className="mt-5 grid grid-cols-2 gap-3">
        {element && (
          <Field label="Area" htmlFor="export-scope" className="col-span-2">
            <select
              id="export-scope"
              className={selectClass}
              value={scope}
              onChange={(e) => setScope(e.target.value as 'element' | 'frame')}
            >
              <option value="element">Selected element ({element.label})</option>
              <option value="frame">Whole frame</option>
            </select>
          </Field>
        )}
        {frames.length > 1 && (
          <Field label="Export as" htmlFor="export-mode" className="col-span-2">
            <select
              id="export-mode"
              className={selectClass}
              value={mode}
              onChange={(e) => setMode(e.target.value as 'separate' | 'combined')}
            >
              <option value="separate">Separate images (ZIP)</option>
              <option value="combined">One combined image</option>
            </select>
          </Field>
        )}
        <Field label="Format" htmlFor="export-format">
          <select
            id="export-format"
            className={selectClass}
            value={format}
            onChange={(e) => setFormat(e.target.value as ExportFormat)}
          >
            <option value="png">PNG</option>
            <option value="jpg">JPG</option>
          </select>
        </Field>
        <Field label="Scale" htmlFor="export-scale">
          <select
            id="export-scale"
            className={selectClass}
            value={scale}
            onChange={(e) => setScale(Number(e.target.value) as ExportScale)}
          >
            {EXPORT_SCALES.map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
        </Field>
        {format === 'jpg' && (
          <Field label={`Quality · ${quality}%`} htmlFor="export-quality" className="col-span-2">
            <input
              id="export-quality"
              type="range"
              min="1"
              max="100"
              value={quality}
              className="w-full accent-brand"
              onChange={(e) => setQuality(Number(e.target.value))}
            />
          </Field>
        )}
      </fieldset>
      {combined ? (
        <div className="mt-5 rounded-lg border border-line-soft p-3 text-sm">
          <div className="flex justify-between gap-3">
            <span>selection.{format}</span>
            <span className="font-mono text-[11px] text-ink-faint">
              {combinedSize.width} × {combinedSize.height} px
            </span>
          </div>
          <p className="mt-2 text-xs text-ink-soft">
            Includes {frames.length} frames with their positions and spacing. Empty space is{' '}
            {format === 'png' ? 'transparent' : 'white'}.
          </p>
        </div>
      ) : (
        <ul
          className="mt-5 max-h-56 overflow-y-auto rounded-lg border border-line-soft divide-y divide-line-soft"
          aria-label="Files to export"
        >
          {frames.map((frame, index) => {
            const size = exportDimensions(crop ?? frame, scale)
            return (
              <li key={frame.id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                <span className="min-w-0 truncate" title={names[index]}>
                  {names[index]}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                  {size.width} × {size.height} px
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {(sizeError || selectionError || error) && (
        <p role="alert" className="mt-3 text-sm text-accent-ink">
          {sizeError || selectionError || error}
        </p>
      )}
      {busy && (
        <p role="status" className="mt-3 text-sm text-ink-soft">
          Rendering {Math.min(completed + 1, frames.length)} of {frames.length}…
        </p>
      )}
      <ModalActions>
        <Button variant="ghost" onClick={close}>
          {busy ? 'Cancel export' : 'Cancel'}
        </Button>
        <Button variant="primary" disabled={busy || !!sizeError || !!selectionError} onClick={startExport}>
          {busy
            ? 'Exporting…'
            : frames.length === 1 || combined
              ? `Export ${format.toUpperCase()}`
              : `Export ${frames.length} frames`}
        </Button>
      </ModalActions>
    </Modal>
  )
}
