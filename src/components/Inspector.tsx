import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Frame } from '../../shared/types'
import { useStore } from '../lib/store'
import { frameHtmlReady } from '../lib/pages'
import { api, errorMessage } from '../lib/api'
import { beginFrameSave } from '../lib/frameSaves'
import {
  copyFramePng,
  downloadFrameExport,
  downloadFrameHtml,
  downloadFramesPdf,
  useFrameExporting,
} from '../lib/frameExport'
import { setExportSettings, useExportSettings } from '../lib/exportSettings'
import { fitExportScale, formatExportScale } from '../../shared/exportScale'
import { ExportOptions, FRAME_FORMATS } from './ExportOptions'
import { deleteFrameTracked, recordUpdate, trackSave } from '../lib/history'
import { setFramesLocked } from '../lib/layerEdits'
import { FrameHistoryModal } from './FrameHistoryModal'
import { FrameApprovalControl } from './FrameApproval'
import { cn } from '@/lib/utils'
import { Panel, PanelClose, PanelHeader, type PanelSurface } from './ui/panel'
import { CopyIcon, DownloadIcon, FrameIcon, LockIcon, RotationIcon } from './ui/icons'
import { Button } from './ui/button'
import { Spinner } from './ui/toast'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { NumberField, PropertyScrubContext, PropertySection, StaticField } from './ui/property-field'
import { normalizeRotation } from '../../shared/frameRotation'
import { MIN_FRAME_SIZE } from '../lib/frameResize'
import { t as translate, useT } from '../lib/i18n'
import { trackExport, trackPngCopy } from '../lib/exportEvents'
import {
  onFrameChange,
  readFrameFill,
  styleElement,
  styleGesture,
  type FrameFill,
  type StylePatch,
} from '../lib/frameBridge'
import { isCanvasElement } from '../lib/drawing'
import { FillSection } from './ElementPanel'

/* the rail's filled buttons: a grey well, 28px, tall enough to hit on a phone */
const fillBtn = 'h-7 rounded-[7px] bg-sub px-2 text-[12px] font-normal text-ink hover:bg-paper-deep max-md:min-h-10'
/* the position and size fields, tall enough to hit on a phone */
const boxField = 'max-md:h-10 max-md:min-h-10'

type BoxKey = 'x' | 'y' | 'width' | 'height' | 'rotation'
type FrameBox = Pick<Frame, BoxKey>
const BOX_KEYS: readonly BoxKey[] = ['x', 'y', 'width', 'height', 'rotation']

function boxOf(frame: Frame): FrameBox {
  return { x: frame.x, y: frame.y, width: frame.width, height: frame.height, rotation: frame.rotation ?? 0 }
}

/* how often a frame being streamed into refreshes the always-open HTML editor */
const HTML_PULL_MS = 250

export function Inspector({
  frame,
  surface = 'floating',
  className,
  style,
}: {
  frame: Frame
  /* 'inline' when the inspector is filling a mobile Sheet */
  surface?: PanelSurface
  className?: string
  style?: CSSProperties
}) {
  const t = useT()
  const select = useStore((s) => s.select)
  const [draft, setDraft] = useState(frame.html)
  const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saved'>('idle')
  const [copiedUrl, setCopiedUrl] = useState(false)
  /* a PDF can take a while, and the button is where the person is looking,
     so it says so until the export lands */
  const exporting = useFrameExporting(frame.id)
  const exportSettings = useExportSettings()
  /* what the frame actually renders at: a huge frame caps a large pick */
  const exportScale = fitExportScale(frame, exportSettings.scale)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [htmlCopy, setHtmlCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  /* the frame's page is here and current: until then its HTML here is a blank
     or stale copy, which is neither shown nor edited (a draft of it would be
     saved over the real document once that arrives) */
  const htmlReady = useStore((s) => frameHtmlReady(s, frame.id))
  /* whether the draft was last synced from a ready copy */
  const draftReady = useRef(htmlReady)
  const queuedSave = useRef<{ timer: number; finish: () => void } | null>(null)
  const copyTimer = useRef<number | null>(null)
  const frameId = useRef(frame.id)
  /* the frame as it was when a scrub began: the drag previews in the store
     and this is what one undo step and one save are measured against */
  const scrubStart = useRef<{ id: string; box: FrameBox; key: BoxKey | null; value: number | undefined } | null>(null)

  /* switching frames resets the draft; otherwise pull in remote html
     updates unless the user is typing. The editor is always on screen, and
     rewriting it costs the browser ~25ms for a 300KB frame, so an agent
     streaming into the selected frame is pulled in at most every
     HTML_PULL_MS, the last chunk always landing. The page arriving always
     resets it: focus in the field while it loaded was not typing, and a
     draft of the blank copy must never be what the next keystroke saves */
  const lastPull = useRef(0)
  /* focus is state, not a check of document.activeElement, so leaving the
     editor re-runs the pull below: an update that arrived while it had focus
     lands then. An edit typed there that has not saved (waiting, in flight,
     or failed: saveState stays 'dirty' until a save succeeds) is never
     replaced; the pull waits for that save */
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    const switched = frameId.current !== frame.id
    frameId.current = frame.id
    const arrived = htmlReady && !draftReady.current
    draftReady.current = htmlReady
    const pull = () => {
      lastPull.current = performance.now()
      setDraft(frame.html)
      setSaveState('idle')
    }
    if (switched || arrived) {
      pull()
      /* a copy confirmation belongs to the frame it was copied from */
      if (switched) setHtmlCopy('idle')
      return
    }
    if (editing || saveState === 'dirty' || frame.html === draft) return
    const wait = lastPull.current + HTML_PULL_MS - performance.now()
    if (wait <= 0) return pull()
    const timer = window.setTimeout(pull, wait)
    return () => window.clearTimeout(timer)
  }, [frame.id, frame.html, draft, editing, saveState, htmlReady])

  /* the confirmation timer must not fire after the panel is gone */
  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current)
    },
    [],
  )

  /* which typed edit is the newest: only its own save may clear 'dirty', so
     an older save finishing late never marks a newer edit as saved */
  const editSeq = useRef(0)
  function onHtmlChange(value: string) {
    if (!frameHtmlReady(useStore.getState(), frame.id)) return
    const seq = ++editSeq.current
    setDraft(value)
    setSaveState('dirty')
    if (queuedSave.current) {
      window.clearTimeout(queuedSave.current.timer)
      queuedSave.current.finish()
    }
    const finish = beginFrameSave(frame.id)
    const timer = window.setTimeout(async () => {
      if (queuedSave.current?.timer === timer) queuedSave.current = null
      const before = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)?.html
      if (before !== undefined) recordUpdate(frame.id, { html: before }, { html: value })
      try {
        await api.updateFrame(frame.id, { html: value })
        if (seq !== editSeq.current) return
        setSaveState('saved')
        window.setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 1500)
      } catch (err) {
        setSaveState('dirty')
        useStore.getState().pushNotice(errorMessage(err, translate('inspector.saveFailed')))
      } finally {
        finish()
      }
    }, 700)
    queuedSave.current = { timer, finish }
  }

  async function copyHtml() {
    /* one timer only, so an older copy can't clear the newest tick early */
    if (copyTimer.current) window.clearTimeout(copyTimer.current)
    try {
      await navigator.clipboard.writeText(draft)
      setHtmlCopy('copied')
      copyTimer.current = window.setTimeout(() => setHtmlCopy('idle'), 1500)
    } catch (caught) {
      console.error(caught)
      /* a failure stays up until the next attempt, so it can be read */
      setHtmlCopy('failed')
    }
  }

  function commitMeta(patch: Partial<Frame>) {
    recordUpdate(frame.id, frame, patch)
    useStore.getState().patchFrameLocal(frame.id, patch)
    const save = api.updateFrame(frame.id, patch)
    trackSave(save)
    save.catch(console.error)
  }

  /* a typed value commits at once; a scrubbed one only previews, and the
     gesture's end commits the whole drag. Only the scrubbed field belongs to
     the gesture: a teammate's move of the same frame meanwhile is theirs, and
     another field committed mid-drag (Tab out of a typed X) is its own edit */
  function editBox(patch: Partial<FrameBox>) {
    const scrub = scrubStart.current
    const key = BOX_KEYS.find((k) => k in patch)
    if (!key) return
    if (scrub) scrub.key ??= key
    if (scrub?.key === key) {
      scrub.value = patch[key]
      useStore.getState().patchFrameLocal(scrub.id, { [key]: patch[key] })
    } else commitMeta(patch)
  }
  const boxScrub = {
    onStart: () => {
      scrubStart.current = { id: frame.id, box: boxOf(frame), key: null, value: undefined }
    },
    onEnd: (cancel: boolean) => {
      const scrub = scrubStart.current
      scrubStart.current = null
      if (!scrub?.key) return
      const { id, key } = scrub
      const from = scrub.box[key]
      const store = useStore.getState()
      if (cancel) {
        store.patchFrameLocal(id, { [key]: from })
        return
      }
      /* the gesture's own latest value, not the store's: a save or broadcast
         landing mid-drag (another field's commit, a teammate) puts the
         server's frame in the store, and that still carries the old size */
      const to = scrub.value
      if (to === undefined || to === from) return
      /* a frame a teammate deleted mid-drag has nothing to commit to */
      if (!store.canvas?.frames.some((f) => f.id === id)) return
      store.patchFrameLocal(id, { [key]: to })
      recordUpdate(id, { [key]: from }, { [key]: to }, true)
      const save = api.updateFrame(id, { [key]: to })
      trackSave(save)
      save.catch(console.error)
    },
  }

  return (
    <Panel
      surface={surface}
      className={cn(
        surface === 'floating' && 'top-2.5 bottom-3.5 w-[244px] transition-[right] duration-150',
        surface === 'docked' && 'w-[244px] border-l',
        'max-md:overflow-y-auto max-md:overscroll-contain',
        className,
      )}
      style={style}
    >
      <PanelHeader className="pl-2.5">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <FrameIcon className="size-3.5 flex-none text-ink-faint" />
          <NameInput key={frame.id} value={frame.name} onCommit={(v) => v.trim() && commitMeta({ name: v.trim() })} />
        </span>
        <PanelClose onClick={() => select(null)} />
      </PanelHeader>
      {frame.locked && (
        <div className="flex items-center justify-between gap-2 border-b border-line-soft bg-sub py-1.5 pr-2 pl-3">
          <span
            className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-soft"
            title={t('inspector.lockedTitle')}
          >
            <LockIcon className="size-3 flex-none" />
            {t('inspector.locked')}
          </span>
          <Button
            variant="bare"
            className="h-6 rounded-[6px] bg-surface px-2 text-[12px] font-normal text-ink shadow-ring"
            onClick={() => setFramesLocked([frame], false)}
          >
            {t('inspector.unlock')}
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <InspectorGroup title={t('inspector.groupDevelopment')}>
          <FrameApprovalControl key={frame.id} frame={frame} hasUnsavedChanges={saveState === 'dirty'} />
        </InspectorGroup>
        <PropertyScrubContext.Provider value={boxScrub}>
          {/* keyed by frame: a value typed for one frame is never committed to the next */}
          <InspectorGroup title={t('inspector.sectionPosition')}>
            <div className="grid grid-cols-2 gap-1.5">
              <NumberField
                key={frame.id}
                label={t('inspector.xPosition')}
                prefix="X"
                unit="px"
                min={-Infinity}
                value={frame.x}
                className={boxField}
                onCommit={(x) => editBox({ x })}
              />
              <NumberField
                key={frame.id}
                label={t('inspector.yPosition')}
                prefix="Y"
                unit="px"
                min={-Infinity}
                value={frame.y}
                className={boxField}
                onCommit={(y) => editBox({ y })}
              />
            </div>
          </InspectorGroup>
          <InspectorGroup title={t('inspector.sectionLayout')}>
            <div className="grid grid-cols-2 gap-1.5">
              <NumberField
                key={frame.id}
                label={t('inspector.width')}
                prefix="W"
                unit="px"
                min={MIN_FRAME_SIZE}
                value={frame.width}
                className={boxField}
                onCommit={(width) => editBox({ width })}
              />
              <NumberField
                key={frame.id}
                label={t('inspector.height')}
                prefix="H"
                unit="px"
                min={MIN_FRAME_SIZE}
                value={frame.height}
                className={boxField}
                onCommit={(height) => editBox({ height })}
              />
              <NumberField
                key={frame.id}
                label={t('inspector.rotation')}
                prefix={<RotationIcon size="rail" />}
                unit="°"
                min={-Infinity}
                value={frame.rotation ?? 0}
                className={boxField}
                onCommit={(rotation) => editBox({ rotation: normalizeRotation(rotation) ?? 0 })}
              />
            </div>
          </InspectorGroup>
        </PropertyScrubContext.Provider>
        {!frame.locked && !isCanvasElement(frame.html) && <FrameFillSection frame={frame} />}
        <InspectorGroup title={t('inspector.groupExport')}>
          <div className="grid grid-cols-2 gap-1.5">
            <div className="col-span-2">
              <ExportOptions value={exportSettings} onChange={setExportSettings} formats={FRAME_FORMATS} compact />
            </div>
            <Button
              variant="bare"
              className={cn(fillBtn, 'col-span-2 gap-1.5')}
              title={exporting ? t('inspector.exportingTitle') : t('inspector.exportImageTitle')}
              disabled={exporting}
              aria-busy={exporting}
              onClick={() => {
                trackExport(exportSettings.format, 1, 'inspector')
                if (exportSettings.format === 'pdf') void downloadFramesPdf(frame.canvasId, [frame])
                else void downloadFrameExport(frame, exportSettings.format, exportSettings.scale)
              }}
            >
              {exporting ? <Spinner className="size-3.5" /> : <DownloadIcon className="size-3.5" />}
              {exporting ? t('inspector.exporting') : t('inspector.export')}
            </Button>
            <Button
              variant="bare"
              className={cn(fillBtn, 'col-span-2')}
              title={t('inspector.copyPngTitle', { scale: formatExportScale(exportScale) })}
              onClick={() => {
                trackPngCopy('frame', 'inspector')
                void copyFramePng(frame, exportSettings.scale)
              }}
            >
              {t('inspector.copyPng')}
            </Button>
            <Button
              variant="bare"
              className={cn(fillBtn, 'col-span-2')}
              title={t('inspector.copyImageUrlTitle')}
              onClick={() => {
                navigator.clipboard.writeText(`${location.origin}/i/${frame.id}.png?scale=${exportScale}`).then(() => {
                  setCopiedUrl(true)
                  window.setTimeout(() => setCopiedUrl(false), 1500)
                }, console.error)
              }}
            >
              {copiedUrl ? t('common.copied') : t('inspector.copyImageUrl')}
            </Button>
          </div>
        </InspectorGroup>
        <InspectorGroup title={t('inspector.groupMemory')}>
          <Button
            variant="bare"
            className={cn(fillBtn, 'w-full')}
            title={t('inspector.pinReferenceTitle')}
            onClick={() => api.pinReference(frame.canvasId, frame.id).catch(console.error)}
          >
            {t('inspector.pinReference')}
          </Button>
        </InspectorGroup>
        {/* a frame is its HTML: the editor is always there, last in the panel,
            so nobody has to find a toggle to see or change the code */}
        <section className="flex min-h-0 flex-col">
          <div className="border-b border-line-soft px-3 py-2">
            <h3 className="mb-1.5 flex h-5 items-center text-[12px] font-normal text-ink-soft">
              {t('inspector.code')}
            </h3>
            <div className="grid grid-cols-2 gap-1.5">
              <Button
                variant="bare"
                className={cn(fillBtn, 'gap-1.5')}
                title={t('inspector.copyHtmlTitle')}
                disabled={!htmlReady}
                onClick={copyHtml}
              >
                <CopyIcon className="size-3.5" />
                {htmlCopy === 'copied' ? t('common.copied') : t('common.copy')}
              </Button>
              <Button
                variant="bare"
                className={cn(fillBtn, 'gap-1.5')}
                title={t('inspector.exportHtmlTitle')}
                onClick={() => downloadFrameHtml(frame, draft)}
              >
                <DownloadIcon className="size-3.5" />
                {t('inspector.export')}
              </Button>
            </div>
            {htmlCopy === 'failed' && (
              <p className="pt-2 text-[11px] text-accent-ink">{t('inspector.copyHtmlFailed')}</p>
            )}
          </div>
          <div className="relative flex min-h-0 flex-col">
            <Textarea
              ref={textareaRef}
              aria-label={t('inspector.editHtml')}
              variant="code"
              className="h-[320px] flex-none max-md:h-auto max-md:min-h-[160px] max-md:flex-1"
              value={htmlReady ? draft : ''}
              readOnly={!htmlReady}
              spellCheck={false}
              placeholder={htmlReady ? '<!doctype html>…' : t('stage.pageLoading')}
              onChange={(e) => onHtmlChange(e.target.value)}
              onFocus={() => setEditing(true)}
              onBlur={() => setEditing(false)}
            />
          </div>
        </section>
      </div>
      <footer className="flex flex-none items-center justify-between gap-2 border-t border-line-soft py-2 pr-2 pl-3">
        <span className="min-w-0 truncate text-[11px] text-ink-faint">
          {saveState === 'dirty'
            ? t('inspector.saving')
            : saveState === 'saved'
              ? t('inspector.saved')
              : t('inspector.lastEditBy', { name: frame.updatedBy })}
        </span>
        <span className="flex flex-none items-center gap-0.5">
          <Button
            variant="bare"
            size="sm"
            className="h-7 rounded-[7px] px-2 text-[12px] font-normal"
            onClick={() => setHistoryOpen(true)}
          >
            {t('inspector.history')}
          </Button>
          <Button
            variant="bare-danger"
            size="sm"
            className="h-7 rounded-[7px] px-2 text-[12px] font-normal"
            disabled={!!frame.locked}
            title={frame.locked ? t('inspector.unlockToDelete') : undefined}
            onClick={() => deleteFrameTracked(frame)}
          >
            {t('common.delete')}
          </Button>
        </span>
      </footer>
      {historyOpen && <FrameHistoryModal frame={frame} onClose={() => setHistoryOpen(false)} />}
    </Panel>
  )
}

/* a burst of render and font-load events shares one read, as the element panel's does */
const FILL_READ_DELAY_MS = 120

type FillRead = { frameId: string; fill: FrameFill }

/* Read the frame's fill into state. Every read takes a ticket, and only the
   newest one's answer lands: reads after an edit and after a render can
   come back out of order, and a stale answer must not move the field. */
function readFillInto(latest: { current: number }, frameId: string, setRead: (read: FillRead) => void) {
  const ticket = ++latest.current
  readFrameFill(frameId)
    .then((fill) => {
      if (fill && ticket === latest.current) setRead({ frameId, fill })
    })
    .catch(console.error)
}

/** The frame's Fill, as Figma's frame has one: the background of the root
 *  element that paints the frame, edited with the element panel's own Fill
 *  section (colour, opacity, tokens, an image fill) through the live frame,
 *  so the edit is saved and undone like any style edit. */
function FrameFillSection({ frame }: { frame: Frame }) {
  const t = useT()
  const [read, setRead] = useState<FillRead | null>(null)
  const latest = useRef(0)
  const fill = read?.frameId === frame.id ? read.fill : null

  useEffect(() => {
    let timer: number | null = null
    const refresh = () => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => readFillInto(latest, frame.id, setRead), FILL_READ_DELAY_MS)
    }
    readFillInto(latest, frame.id, setRead)
    const off = onFrameChange(frame.id, refresh)
    return () => {
      /* an answer still on its way belongs to the frame or document before */
      latest.current += 1
      off()
      if (timer) window.clearTimeout(timer)
    }
  }, [frame.id, frame.html])

  /* until the frame answers (its page loading, its iframe not up yet) */
  if (!fill)
    return (
      <PropertySection title={t('inspector.sectionFill')}>
        <StaticField>{t('inspector.fillReading')}</StaticField>
      </PropertySection>
    )
  if (fill.locked) return null
  const { selector } = fill

  function apply(styles: StylePatch) {
    /* the colour is the fill: a gradient over it goes, and a token set
       through the shorthand is unset before the longhand replaces it */
    const patch: StylePatch = {
      ...(fill?.shorthand && 'background-color' in styles ? { background: null } : {}),
      ...styles,
      ...(fill?.overlay && 'background-color' in styles ? { 'background-image': 'none' } : {}),
    }
    styleElement(frame.id, selector, patch)
      .then(() => readFillInto(latest, frame.id, setRead))
      .catch(console.error)
  }
  function scrub(phase: 'begin' | 'commit' | 'cancel') {
    styleGesture(frame.id, selector, phase)
      .then(() => readFillInto(latest, frame.id, setRead))
      .catch(console.error)
  }

  return (
    <PropertyScrubContext.Provider
      value={{ onStart: () => scrub('begin'), onEnd: (cancel) => scrub(cancel ? 'cancel' : 'commit') }}
    >
      <FillSection
        frame={frame}
        selector={selector}
        info={{ backgroundColor: fill.backgroundColor, inline: fill.inline, vector: null, image: fill.image }}
        apply={apply}
      />
    </PropertyScrubContext.Provider>
  )
}

/** One titled block of the rail: a 12px grey heading over its controls. */
function InspectorGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-line-soft px-3 py-2">
      <h3 className="mb-1.5 flex h-5 items-center text-[12px] font-normal text-ink-soft">{title}</h3>
      {children}
    </section>
  )
}

/** The frame's name, edited in place in the panel header. */
function NameInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const t = useT()
  const [draft, setDraft] = useState(value)
  /* a committed or remote value replaces whatever was being typed */
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(value)
  }
  return (
    <Input
      variant="bare"
      inputSize="auto"
      aria-label={t('inspector.frameName')}
      className="h-7 min-w-0 flex-1 truncate rounded-[6px] px-1 text-[12.5px] font-medium hover:bg-sub focus:bg-surface focus:shadow-elevation-1-focus md:text-[12.5px] max-md:min-h-10"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}
