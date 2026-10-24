import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { Frame } from '../../shared/types'
import { useStore } from '../lib/store'
import {
  editElementGeometry,
  inspectElement,
  onFrameChange,
  styleElement,
  styleGesture,
  type ElementInfo,
  type GeometryEdit,
  type StylePatch,
} from '../lib/frameBridge'
import { ancestorsOf, buildLayerTree, elementHtml, findLayer, layerName } from '../lib/layers'
import { replaceLayerHtml } from '../lib/layerEdits'
import {
  aspectRatio,
  borderSummary,
  colorAlpha,
  colorWithAlpha,
  lengthValue,
  rgbToHex,
  sizeMode,
  type SizeMode,
} from '../lib/cssValues'
import { flexSizeAxis } from '../lib/flexLayout'
import { cn } from '@/lib/utils'
import { LayerKindIcon } from './LayerKindIcon'
import { FlexLayoutControls, PaddingControls } from './FlexLayoutControls'
import {
  Panel,
  PanelBody,
  PanelClose,
  PanelHeader,
  PanelTab,
  PanelTabPanel,
  PanelTabs,
  PanelTabsRoot,
} from './ui/panel'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Tooltip } from './ui/tooltip'
import {
  AlignCenterIcon,
  AlignJustifyIcon,
  AlignLeftIcon,
  AlignRightIcon,
  ArrowUpIcon,
  LinkIcon,
  UnlinkIcon,
  AlignStartVerticalIcon,
  AlignCenterVerticalIcon,
  AlignEndVerticalIcon,
  AlignStartHorizontalIcon,
  AlignCenterHorizontalIcon,
  AlignEndHorizontalIcon,
  FlipHorizontal2Icon,
  FlipVertical2Icon,
  CircleDashedIcon,
  DropletIcon,
  RadiusIcon,
  EyeIcon,
  EyeClosedIcon,
} from './ui/icons'
import { Switch } from './ui/switch'
import { Segmented, SegmentedItem } from './ui/segmented'
import {
  ColorField,
  FieldUnit,
  NumberField,
  LengthField,
  PropertyScrubContext,
  PropertyRow,
  PropertySection,
  SelectField,
  StaticField,
} from './ui/property-field'

const TAB_KEY = 'doop:element-panel-tab'
/* Only refreshes wait for streaming chunks to settle; a new selection is
   inspected immediately. */
const INSPECT_DELAY_MS = 120
const HTML_SAVE_DELAY_MS = 700

type Tab = 'design' | 'html'

function readTab(): Tab {
  try {
    return localStorage.getItem(TAB_KEY) === 'html' ? 'html' : 'design'
  } catch {
    return 'design'
  }
}

/** The element properties rail — the second panel at the right, opened from
 *  a Layers row. Reads the element's computed styles out of the live frame
 *  and writes edits back as inline styles; the HTML tab edits its markup. */
export function ElementPanel({
  frame,
  selector,
  className,
  style,
}: {
  frame: Frame
  selector: string
  className?: string
  /** carries `right`, so it opens beside the Agents panel at the edge */
  style?: CSSProperties
}) {
  /* the tab sticks across elements and visits: walking the tree in HTML
     view must not snap back to Design on every row */
  const [tab, setTab] = useState<Tab>(readTab)
  /* Values belong to their selector. A newly selected element shows loading
     placeholders until its own read lands, so old values cannot be edited. */
  const [read, setRead] = useState<{ selector: string; info: ElementInfo } | null>(null)
  const info = read?.selector === selector ? read.info : null
  const inspected = useRef<{ frameId: string; selector: string; ready: boolean } | null>(null)

  const tree = useMemo(() => buildLayerTree(frame.html), [frame.html])
  const node = useMemo(() => findLayer(tree, selector), [tree, selector])
  const parentNode = useMemo(() => ancestorsOf(tree, selector)?.at(-1) ?? null, [tree, selector])
  const hasText = useMemo(() => {
    if (info) return info.hasText
    try {
      const element = new DOMParser().parseFromString(frame.html, 'text/html').querySelector(selector)
      return Array.from(element?.childNodes ?? []).some(
        (child) => child.nodeType === Node.TEXT_NODE && /\S/.test(child.textContent ?? ''),
      )
    } catch {
      return false
    }
  }, [frame.html, selector, info])

  /* re-read after every html change — remote edits and our own saves alike —
     and when the runtime finishes rendering or loading fonts */
  useEffect(() => {
    let live = true
    let timer: number | null = null
    let request = 0
    if (inspected.current?.frameId !== frame.id || inspected.current.selector !== selector) {
      inspected.current = { frameId: frame.id, selector, ready: false }
    }
    const read = () => {
      if (timer) window.clearTimeout(timer)
      const currentRequest = ++request
      inspectElement(frame.id, selector)
        .then((next) => {
          if (!live || currentRequest !== request || !next) return
          inspected.current = { frameId: frame.id, selector, ready: true }
          setRead({ selector, info: next })
        })
        .catch(console.error)
    }
    if (inspected.current.ready) timer = window.setTimeout(read, INSPECT_DELAY_MS)
    else read()
    const off = onFrameChange(frame.id, read)
    return () => {
      live = false
      off()
      if (timer) window.clearTimeout(timer)
    }
  }, [frame.id, frame.html, selector])

  function updateRead(request: Promise<ElementInfo | null>) {
    request
      .then((next) => {
        if (next) setRead((r) => (r && r.selector !== selector ? r : { selector, info: next }))
      })
      .catch(console.error)
  }

  function apply(styles: StylePatch) {
    if (info) updateRead(styleElement(frame.id, selector, styles))
  }

  function editGeometry(edit: GeometryEdit) {
    if (info) updateRead(editElementGeometry(frame.id, selector, edit))
  }

  function scrub(phase: 'begin' | 'commit' | 'cancel') {
    updateRead(styleGesture(frame.id, selector, phase))
  }

  function selectTab(next: Tab) {
    setTab(next)
    try {
      localStorage.setItem(TAB_KEY, next)
    } catch {
      /* private mode: the choice just doesn't stick */
    }
  }

  function close() {
    useStore.getState().pickElement(null)
  }

  const name = node ? layerName(node) : selector.split(' > ').at(-1)
  const parentLabel = parentNode ? `${parentNode.tag}${parentNode.detail}` : 'body'

  return (
    <Panel
      className={cn('top-2.5 max-h-[calc(100%-24px)] w-[244px] transition-[right] duration-150', className)}
      style={style}
    >
      <PanelTabsRoot value={tab} onValueChange={(v) => selectTab(v === 'html' ? 'html' : 'design')}>
        <PanelHeader className="pl-2">
          <PanelTabs>
            <PanelTab value="design">Design</PanelTab>
            <PanelTab value="html">HTML</PanelTab>
          </PanelTabs>
          <PanelClose onClick={close} />
        </PanelHeader>
        <div className="flex flex-none items-center gap-[7px] border-b border-line-soft px-3 py-2.5">
          <span className="grid size-5 flex-none place-items-center text-ink-faint">
            <LayerKindIcon kind={node?.kind ?? 'box'} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
            {name}
            <small className="ml-[5px] text-[11px] font-normal text-ink-faint">in {parentLabel}</small>
          </span>
          {parentNode && (
            <Tooltip label="Select parent" side="bottom" align="end">
              <Button
                variant="bare"
                size="icon-sm"
                className="size-[22px] text-ink-faint hover:bg-paper-deep hover:text-ink"
                aria-label="Select parent"
                onClick={() =>
                  useStore.getState().setSelectedElement({ frameId: frame.id, selector: parentNode.selector })
                }
              >
                <ArrowUpIcon className="size-3.5" />
              </Button>
            </Tooltip>
          )}
        </div>
        <PanelTabPanel value="design">
          <PanelBody>
            {info ? (
              <PropertyScrubContext.Provider
                value={{ onStart: () => scrub('begin'), onEnd: (cancel) => scrub(cancel ? 'cancel' : 'commit') }}
              >
                <DesignTab key={`${frame.id}:${selector}`} info={info} apply={apply} editGeometry={editGeometry} />
              </PropertyScrubContext.Provider>
            ) : (
              <Waiting hasText={hasText} />
            )}
          </PanelBody>
        </PanelTabPanel>
        <PanelTabPanel value="html">
          <HtmlTab key={selector} frame={frame} selector={selector} />
        </PanelTabPanel>
      </PanelTabsRoot>
    </Panel>
  )
}

const LOADING_SECTIONS = [
  { title: 'Position', rows: ['Type', 'Order'] },
  { title: 'Layout', rows: ['Min width', 'Display', 'Gap'] },
  { title: 'Appearance', rows: ['Opacity', 'Radius'] },
  { title: 'Fill', rows: ['Color'] },
  { title: 'Stroke', rows: ['Color', 'Width'] },
  { title: 'Text', rows: ['Font', 'Size', 'Color', 'Align'] },
]

function Waiting({ hasText }: { hasText: boolean }) {
  return (
    <div aria-busy="true">
      <span role="status" className="sr-only">
        Reading the element…
      </span>
      <div aria-hidden="true">
        {LOADING_SECTIONS.filter((section) => section.title !== 'Text' || hasText).map((section) => (
          <PropertySection key={section.title} title={section.title}>
            {section.rows.map((label) => (
              <PropertyRow key={label} label={label}>
                <StaticField>
                  <span className="h-1.5 w-1/2 rounded-tag bg-ink/10" />
                </StaticField>
              </PropertyRow>
            ))}
          </PropertySection>
        ))}
      </div>
    </div>
  )
}

/* ---- Design tab ---- */

const DISPLAYS: { value: string; label: string }[] = [
  { value: 'block', label: 'block' },
  { value: 'flex', label: 'flex' },
  { value: 'grid', label: 'grid' },
  { value: 'inline-block', label: 'inline-block' },
  { value: 'inline-flex', label: 'inline-flex' },
  { value: 'inline', label: 'inline' },
  { value: 'none', label: 'none' },
]
const POSITIONS = ['static', 'relative', 'absolute', 'fixed', 'sticky']
const WEIGHTS = ['100', '200', '300', '400', '500', '600', '700', '800', '900']
const LAYER_ALIGNS = [
  { axis: 'x', edge: 'start', label: 'Align layer left', Icon: AlignStartVerticalIcon },
  { axis: 'x', edge: 'center', label: 'Center layer horizontally', Icon: AlignCenterVerticalIcon },
  { axis: 'x', edge: 'end', label: 'Align layer right', Icon: AlignEndVerticalIcon },
  { axis: 'y', edge: 'start', label: 'Align layer top', Icon: AlignStartHorizontalIcon },
  { axis: 'y', edge: 'center', label: 'Center layer vertically', Icon: AlignCenterHorizontalIcon },
  { axis: 'y', edge: 'end', label: 'Align layer bottom', Icon: AlignEndHorizontalIcon },
] as const
const ALIGNS = [
  { value: 'left', label: 'Align left', Icon: AlignLeftIcon },
  { value: 'center', label: 'Align center', Icon: AlignCenterIcon },
  { value: 'right', label: 'Align right', Icon: AlignRightIcon },
  { value: 'justify', label: 'Justify', Icon: AlignJustifyIcon },
]
const SYSTEM_FONTS = [
  { value: 'system-ui, sans-serif', label: 'System UI' },
  { value: 'Arial, sans-serif', label: 'Arial' },
  { value: 'Helvetica, sans-serif', label: 'Helvetica' },
  { value: 'Verdana, sans-serif', label: 'Verdana' },
  { value: 'Trebuchet MS, sans-serif', label: 'Trebuchet MS' },
  { value: 'Georgia, serif', label: 'Georgia' },
  { value: 'Times New Roman, serif', label: 'Times New Roman' },
  { value: 'Courier New, monospace', label: 'Courier New' },
  { value: 'ui-monospace, monospace', label: 'Monospace' },
]

function fontName(value: string) {
  return (
    value
      .match(/^(?:"([^"]+)"|'([^']+)'|([^,]+))/)
      ?.slice(1)
      .find(Boolean)
      ?.trim() ?? value
  )
}

/** Keep the current stack intact, and offer fonts already supplied by the
 *  frame alongside system faces that need no additional font download. */
function fontOptions(info: ElementInfo) {
  const seen = new Set<string>()
  return [
    ...[info.fontFamily, ...info.fontFamilies].map((value) => ({
      value,
      label: fontName(value),
    })),
    ...SYSTEM_FONTS,
  ].filter(({ value }) => {
    const family = fontName(value).toLowerCase()
    if (seen.has(family)) return false
    seen.add(family)
    return true
  })
}
const SIZE_MODES: { value: SizeMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'fixed', label: 'Fixed' },
  { value: 'fill', label: 'Fill' },
  { value: 'hug', label: 'Hug' },
]

function displayValue(info: ElementInfo): string {
  return DISPLAYS.some((d) => d.value === info.display) ? info.display : 'block'
}

function parentLayout(info: ElementInfo): string {
  const p = info.parent
  if (!p) return ''
  if (p.display === 'grid' || p.display === 'inline-grid') return 'grid'
  if (p.display === 'flex' || p.display === 'inline-flex') return `flex ${p.flexDirection.replace('-reverse', '')}`
  return p.display
}

function DesignTab({
  info,
  apply,
  editGeometry,
}: {
  info: ElementInfo
  apply: (styles: StylePatch) => void
  editGeometry: (edit: GeometryEdit) => void
}) {
  const ratio = aspectRatio(info.aspectRatio, info.naturalAspectRatio)
  const canLink = (info.width ?? 0) > 0 && (info.height ?? 0) > 0
  const visible = info.visibility !== 'hidden'
  const fill = rgbToHex(info.backgroundColor, true)
  const fillAlpha = colorAlpha(info.backgroundColor)
  const borderColor = rgbToHex(info.borderColor)
  const isFlex = info.display === 'flex' || info.display === 'inline-flex'
  const border = borderSummary(info.borderWidths)
  const textAlign =
    info.textAlign === 'start'
      ? info.direction === 'rtl'
        ? 'right'
        : 'left'
      : info.textAlign === 'end'
        ? info.direction === 'rtl'
          ? 'left'
          : 'right'
        : info.textAlign
  const flexAxis = flexSizeAxis(info)
  function modeFor(axis: 'width' | 'height') {
    return flexAxis === axis && info.flexGrow > 0 ? 'fill' : sizeMode(info[`${axis}Value`])
  }
  function fixedSize(axis: 'width' | 'height', value: number): StylePatch {
    return {
      [axis]: `${Math.round(Math.max(0, value) * 100) / 100}px`,
      ...(axis === flexAxis ? { 'flex-grow': '0', 'flex-shrink': '0', 'flex-basis': 'auto' } : {}),
    }
  }
  function automaticSize(axis: 'width' | 'height'): StylePatch {
    return {
      [axis]: 'auto',
      ...(axis === flexAxis ? { 'flex-grow': '0', 'flex-shrink': '0', 'flex-basis': 'auto' } : {}),
    }
  }
  function setSize(axis: 'width' | 'height', mode: SizeMode, value = info[axis] ?? 0) {
    const other = axis === 'width' ? 'height' : 'width'
    const paired = ratio === null ? {} : automaticSize(other)
    const flex: StylePatch = axis === flexAxis ? { 'flex-grow': '0', 'flex-shrink': '0', 'flex-basis': 'auto' } : {}
    if (mode === 'fixed') {
      apply({
        ...fixedSize(axis, value),
        ...(ratio === null ? {} : fixedSize(other, axis === 'width' ? value / ratio : value * ratio)),
      })
    } else if (mode === 'fill' && axis === flexAxis) {
      apply({
        ...paired,
        [axis]: 'auto',
        'flex-grow': '1',
        'flex-shrink': '1',
        'flex-basis': '0px',
        [`min-${axis}`]: '0px',
      })
    } else if (mode === 'fill') {
      // A 100% content box would overflow by its own padding and borders.
      const extra = info.boxSizing === 'border-box' ? 0 : info.boxExtras[axis]
      apply({ ...paired, [axis]: extra ? `calc(100% - ${extra}px)` : '100%' })
    } else apply({ ...paired, ...flex, [axis]: mode === 'hug' ? 'fit-content' : 'auto' })
  }
  function toggleRatio() {
    if (ratio === null) {
      apply({
        'aspect-ratio': `${info.width} / ${info.height}`,
        ...(modeFor('width') === 'fill'
          ? automaticSize('height')
          : modeFor('height') === 'fill'
            ? automaticSize('width')
            : {}),
      })
      return
    }
    // Preserve dimensions that CSS derived from the ratio, including authored
    // auto/fit-content, while keeping existing fixed and Fill sizes responsive.
    apply({
      'aspect-ratio': 'auto',
      ...(['auto', 'hug'].includes(modeFor('width')) && info.width !== null ? fixedSize('width', info.width) : {}),
      ...(['auto', 'hug'].includes(modeFor('height')) && info.height !== null ? fixedSize('height', info.height) : {}),
    })
  }
  return (
    <>
      <PropertySection title="Alignment">
        <div className="flex gap-1" role="group" aria-label="Layer alignment within parent">
          {LAYER_ALIGNS.map(({ axis, edge, label, Icon }) => (
            <Button
              key={label}
              variant="bare"
              size="icon-sm"
              className="h-[26px] min-w-0 flex-1 rounded-[7px] bg-sub text-ink-soft hover:bg-paper-deep"
              aria-label={label}
              title={`${label} within parent`}
              disabled={!info.geometry.canAlign}
              onClick={() => editGeometry({ kind: 'align', axis, edge })}
            >
              <Icon size="rail" />
            </Button>
          ))}
        </div>
      </PropertySection>
      <PropertySection title="Position">
        <div className="grid grid-cols-2 gap-1.5" title="Rendered position relative to parent, in frame pixels">
          <NumberField
            label="X position"
            min={-Infinity}
            prefix="X"
            value={info.geometry.x}
            unit="px"
            disabled={!info.geometry.enabled}
            onCommit={(value) => editGeometry({ kind: 'position', axis: 'x', value })}
          />
          <NumberField
            label="Y position"
            min={-Infinity}
            prefix="Y"
            value={info.geometry.y}
            unit="px"
            disabled={!info.geometry.enabled}
            onCommit={(value) => editGeometry({ kind: 'position', axis: 'y', value })}
          />
        </div>
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          <NumberField
            label="Rotation"
            min={-Infinity}
            prefix={<CircleDashedIcon size="rail" />}
            value={info.geometry.rotation}
            unit="°"
            disabled={!info.geometry.enabled}
            onCommit={(value) => editGeometry({ kind: 'rotate', value })}
          />
          <div className="grid grid-cols-2 gap-1.5">
            {(['x', 'y'] as const).map((axis) => {
              const Icon = axis === 'x' ? FlipHorizontal2Icon : FlipVertical2Icon
              const label = axis === 'x' ? 'Flip horizontally' : 'Flip vertically'
              const pressed = (axis === 'x' ? info.geometry.scaleX : info.geometry.scaleY) < 0
              return (
                <Button
                  key={axis}
                  variant="bare"
                  size="icon-sm"
                  aria-label={label}
                  title={label}
                  aria-pressed={pressed}
                  disabled={!info.geometry.enabled}
                  className={cn(
                    'h-[26px] w-full rounded-[7px] bg-sub text-ink-soft hover:bg-paper-deep',
                    pressed && 'bg-paper-deep text-ink',
                  )}
                  onClick={() => editGeometry({ kind: 'flip', axis })}
                >
                  <Icon size="rail" />
                </Button>
              )
            })}
          </div>
        </div>
        <PropertyRow label="Type">
          <SelectField
            label="Position type"
            value={info.position}
            options={POSITIONS.map((p) => ({ value: p, label: p }))}
            onChange={(v) => apply({ position: v })}
          />
        </PropertyRow>
        <PropertyRow label="Order">
          <StaticField>
            {info.index}
            <FieldUnit>
              of {info.count}
              {parentLayout(info) && ` · ${parentLayout(info)}`}
            </FieldUnit>
          </StaticField>
        </PropertyRow>
      </PropertySection>
      <PropertySection
        title="Layout"
        action={
          <Tooltip
            label={
              ratio !== null
                ? 'Unlink width and height'
                : canLink
                  ? 'Link width and height'
                  : 'Set a positive width and height to link them'
            }
          >
            <span>
              <Button
                variant="bare"
                size="icon-sm"
                className={cn(
                  'size-5 rounded-tag',
                  ratio !== null ? 'bg-ink text-paper hover:bg-ink/85 hover:text-paper' : 'text-ink-faint',
                )}
                aria-label="Link width and height"
                aria-pressed={ratio !== null}
                disabled={ratio === null && !canLink}
                onClick={toggleRatio}
              >
                {ratio !== null ? <LinkIcon size="rail" /> : <UnlinkIcon size="rail" />}
              </Button>
            </span>
          </Tooltip>
        }
      >
        <div className="grid grid-cols-2 gap-1.5">
          {(['width', 'height'] as const).map((axis) => (
            <div key={axis} className="flex min-w-0 flex-col gap-1">
              <NumberField
                label={axis === 'width' ? 'Width' : 'Height'}
                prefix={axis === 'width' ? 'W' : 'H'}
                value={info[axis]}
                unit="px"
                onCommit={(v) => setSize(axis, 'fixed', v)}
              />
              <SelectField
                label={`${axis === 'width' ? 'Width' : 'Height'} sizing`}
                value={modeFor(axis)}
                options={SIZE_MODES}
                onChange={(v) => setSize(axis, v)}
              />
            </div>
          ))}
        </div>
        <PropertyRow label="Min width">
          <LengthField
            label="Minimum width"
            value={info.inline['min-width'] ?? (info.minWidth === '0px' ? '' : info.minWidth)}
            placeholder="auto"
            onCommit={(v) => apply({ 'min-width': lengthValue(v) })}
          />
        </PropertyRow>
        <PropertyRow label="Display">
          <SelectField
            label="Display"
            value={displayValue(info)}
            options={DISPLAYS}
            onChange={(v) => apply({ display: v })}
          />
        </PropertyRow>
        {!isFlex && (
          <>
            {info.display.includes('grid') && (
              <PropertyRow label="Gap">
                <NumberField
                  label="Row gap"
                  value={info.rowGap ?? 0}
                  unit="px"
                  onCommit={(v) => apply({ 'row-gap': `${Math.max(0, v)}px` })}
                />
                <NumberField
                  label="Column gap"
                  value={info.columnGap ?? 0}
                  unit="px"
                  onCommit={(v) => apply({ 'column-gap': `${Math.max(0, v)}px` })}
                />
              </PropertyRow>
            )}
            <PaddingControls info={info} apply={apply} />
          </>
        )}
      </PropertySection>
      {isFlex && <FlexLayoutControls info={info} apply={apply} />}
      <PropertySection
        title="Appearance"
        action={
          <Button
            variant="bare"
            size="icon-sm"
            className="size-5 rounded-tag text-ink-faint"
            aria-label={visible ? 'Hide element' : 'Show element'}
            title={visible ? 'Hide element' : 'Show element'}
            aria-pressed={!visible}
            onClick={() => apply({ visibility: visible ? 'hidden' : 'visible' })}
          >
            {visible ? <EyeIcon size="rail" /> : <EyeClosedIcon size="rail" />}
          </Button>
        }
      >
        <div className="grid grid-cols-2 gap-1.5">
          <NumberField
            label="Element opacity"
            max={100}
            prefix={<DropletIcon size="rail" />}
            value={info.opacity === null ? null : Math.round(info.opacity * 100)}
            unit="%"
            onCommit={(v) => apply({ opacity: String(Math.min(100, Math.max(0, v)) / 100) })}
          />
          <NumberField
            label="Corner radius"
            prefix={<RadiusIcon size="rail" />}
            value={info.borderRadius}
            unit="px"
            onCommit={(v) => apply({ 'border-radius': `${Math.max(0, v)}px` })}
          />
        </div>
        <label className="mt-2 flex h-5 cursor-pointer items-center justify-between text-[11.5px] text-ink-soft">
          Clip content
          <Switch
            size="sm"
            aria-label="Clip content"
            className="data-[state=checked]:bg-ink"
            checked={info.clipsContent}
            onCheckedChange={(on) => apply({ overflow: on ? 'hidden' : 'visible' })}
          />
        </label>
      </PropertySection>
      <PropertySection title="Fill">
        <div className="grid grid-cols-[minmax(0,1fr)_64px] gap-1.5">
          <ColorField
            label="Fill color"
            value={fillAlpha === 0 && fill === '#000000' ? null : fill}
            onCommit={(v) =>
              apply({
                'background-color': v
                  ? colorWithAlpha(v, fillAlpha === 0 && (!fill || fill === '#000000') ? 1 : fillAlpha)
                  : 'transparent',
              })
            }
          />
          <NumberField
            label="Fill opacity"
            max={100}
            value={Math.round(fillAlpha * 100)}
            unit="%"
            onCommit={(v) => apply({ 'background-color': colorWithAlpha(fill ?? info.backgroundColor, v / 100) })}
          />
        </div>
      </PropertySection>
      <PropertySection title="Stroke">
        <div className="grid grid-cols-[minmax(0,1fr)_64px] gap-1.5">
          <ColorField
            label="Border color"
            value={borderColor}
            onCommit={(v) =>
              apply({ 'border-color': v, ...(v && info.borderStyle === 'none' ? { 'border-style': 'solid' } : {}) })
            }
          />
          <NumberField
            label="Border width"
            value={border.width}
            unit="px"
            onCommit={(v) =>
              apply({
                'border-width': `${Math.max(0, v)}px`,
                ...(v > 0 && info.borderStyle === 'none' ? { 'border-style': 'solid' } : {}),
              })
            }
          />
        </div>
        {border.sides && <p className="mt-1 text-[10.5px] text-ink-faint">Sides: {border.sides}</p>}
      </PropertySection>
      {info.hasText && (
        <PropertySection title="Text">
          <PropertyRow label="Font">
            <SelectField
              label="Font family"
              value={info.fontFamily}
              options={fontOptions(info)}
              onChange={(v) => apply({ 'font-family': v })}
            />
          </PropertyRow>
          <PropertyRow label="Size">
            <NumberField
              label="Font size"
              value={info.fontSize}
              unit="px"
              onCommit={(v) => apply({ 'font-size': `${v}px` })}
            />
            <SelectField
              className="flex-[0_0_66px]"
              label="Font weight"
              value={info.fontWeight}
              options={[...new Set([...WEIGHTS, info.fontWeight])]
                .sort((a, b) => Number(a) - Number(b))
                .map((w) => ({ value: w, label: w }))}
              onChange={(v) => apply({ 'font-weight': v })}
            />
          </PropertyRow>
          <PropertyRow label="Color">
            <ColorField value={rgbToHex(info.color)} onCommit={(v) => apply({ color: v })} />
          </PropertyRow>
          <PropertyRow label="Align">
            <Segmented
              aria-label="Text alignment"
              className="w-full gap-1 rounded-none bg-transparent p-0"
              value={textAlign}
              onValueChange={(v) => apply({ 'text-align': v })}
            >
              {ALIGNS.map(({ value, label, Icon }) => (
                <SegmentedItem
                  key={value}
                  value={value}
                  aria-label={label}
                  title={label}
                  className="grid h-[26px] min-h-0 flex-1 place-items-center rounded-[7px] bg-sub p-0 hover:bg-paper-deep sm:flex-1"
                >
                  <Icon size="rail" />
                </SegmentedItem>
              ))}
            </Segmented>
          </PropertyRow>
        </PropertySection>
      )}
    </>
  )
}

/* ---- HTML tab ---- */

function HtmlTab({ frame, selector }: { frame: Frame; selector: string }) {
  const source = useMemo(() => elementHtml(frame.html, selector) ?? '', [frame.html, selector])
  const [draft, setDraft] = useState(source)
  const [typing, setTyping] = useState(false)
  /* the save waiting for the typing to pause; flushed when the editor goes
     away so a quick switch to another row neither loses nor delays the edit */
  const pendingSave = useRef<{ timer: number; run: () => void } | null>(null)
  useEffect(
    () => () => {
      if (!pendingSave.current) return
      window.clearTimeout(pendingSave.current.timer)
      pendingSave.current.run()
    },
    [],
  )
  /* remote html changes replace the draft unless the person is typing */
  const [seen, setSeen] = useState(source)
  if (seen !== source) {
    setSeen(source)
    if (!typing) setDraft(source)
  }

  function onChange(value: string) {
    setDraft(value)
    if (pendingSave.current) window.clearTimeout(pendingSave.current.timer)
    const run = () => {
      pendingSave.current = null
      const live = useStore.getState().canvas?.frames.find((f) => f.id === frame.id) ?? frame
      replaceLayerHtml(live, selector, value)
    }
    pendingSave.current = { timer: window.setTimeout(run, HTML_SAVE_DELAY_MS), run }
  }

  return (
    <Textarea
      variant="code"
      className="min-h-[320px] flex-1"
      value={draft}
      spellCheck={false}
      onFocus={() => setTyping(true)}
      onBlur={() => setTyping(false)}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
