import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { Frame } from '../../shared/types'
import { pickedSelectors, useStore } from '../lib/store'
import {
  editElementGeometry,
  editPickedLayers,
  type PickedLayerEdit,
  type InspectedLayer,
  type PanelEditPhase,
  inspectElement,
  onFrameChange,
  onTextSelection,
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
  commonValue,
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
  type PanelSurface,
} from './ui/panel'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { ImageFill } from './ImageFill'
import { InteractionsPanel } from './InteractionsPanel'
import { ComponentSection } from './ComponentSection'
import { Tooltip } from './ui/tooltip'
import { familyWeights, fontStack, libraryFamilies } from '../../shared/fonts'
import { WEB_FONTS, webFontStack } from '../../shared/webFonts'
import { useCanvasFonts } from '../lib/customFonts'
import { DEVICE_FONTS } from '../lib/deviceFonts'
import {
  aliasOf,
  effectiveValue,
  frameTheme,
  isTokenName,
  nextTokenName,
  normalizeTokenName,
  resolveToken,
  sortTokens,
  tokenLabel,
  type DesignToken,
  type TokenType,
} from '../../shared/designTokens'
import { TOKEN_TYPE_LABEL, TokenSwatch } from './TokensPanel'
import { api } from '../lib/api'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { BracesIcon, PlusIcon } from './ui/icons'
import type { FieldToken } from './ui/property-field'
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
  RotationIcon,
  TextSizeIcon,
  StrokeWidthIcon,
  ColumnGapIcon,
  RowGapIcon,
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
import { useT, type PlainMessageKey } from '../lib/i18n'
import { LayerExportSection } from './LayerExportSection'

const TAB_KEY = 'doop:element-panel-tab'
/* Only refreshes wait for streaming chunks to settle; a new selection is
   inspected immediately. */
const INSPECT_DELAY_MS = 120
/* how long the previous element's values may stand in (inert) for the next
   one's before the panel admits it is still reading: most reads land within
   a frame or two, and a skeleton flashed in between reads as the panel
   closing and reopening */
const STALE_GRACE_MS = 400
const HTML_SAVE_DELAY_MS = 700
/* the corner radius slider's span; a typed value may go past it */
const RADIUS_SLIDE = [0, 100] as const

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
  surface = 'floating',
  className,
  style,
}: {
  frame: Frame
  selector: string
  surface?: Exclude<PanelSurface, 'inline'>
  className?: string
  /** carries `right`, so it opens beside the Agents panel at the edge */
  style?: CSSProperties
}) {
  /* the tab sticks across elements and visits: walking the tree in HTML
     view must not snap back to Design on every row */
  const t = useT()
  const [tab, setTab] = useState<Tab>(readTab)
  const picks = useStore((s) => {
    if (s.selectedElement?.frameId !== frame.id || s.selectedElement.selector !== selector) return null
    const selectors = pickedSelectors(s)
    return selectors.length > 1 ? selectors : null
  })
  const multiple = picks !== null
  const prototypeMode = useStore((s) => s.prototypeMode)
  /* Values belong to their element. A newly selected one keeps the previous
     values on screen, inert, until its own read lands (loading placeholders
     only once that takes a while), so old values are never edited and the
     panel does not blink between two layers. */
  const [read, setRead] = useState<{ frameId: string; selector: string; info: ElementInfo } | null>(null)
  const info = read?.frameId === frame.id && read.selector === selector ? read.info : null
  const [slowFor, setSlowFor] = useState<string | null>(null)
  const target = `${frame.id}:${selector}`
  /* the grace belongs to one visit: once the read lands, a later return to
     this layer gets its grace again */
  if (info && slowFor !== null) setSlowFor(null)
  const standIn = !info && read && slowFor !== target ? read : null
  useEffect(() => {
    if (info || multiple) return
    const timer = window.setTimeout(() => setSlowFor(target), STALE_GRACE_MS)
    return () => window.clearTimeout(timer)
  }, [info, target, multiple])
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
    if (multiple) return
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
          setRead({ frameId: frame.id, selector, info: next })
        })
        .catch(console.error)
    }
    /* a burst of render and font-load events shares one delayed read */
    const refresh = () => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(read, INSPECT_DELAY_MS)
    }
    if (inspected.current.ready) refresh()
    else read()
    const off = onFrameChange(frame.id, refresh)
    const offSelection = onTextSelection(frame.id, refresh)
    return () => {
      live = false
      off()
      offSelection()
      if (timer) window.clearTimeout(timer)
    }
  }, [frame.id, frame.html, selector, multiple])

  function updateRead(request: Promise<ElementInfo | null>) {
    request
      .then((next) => {
        if (next)
          setRead((r) =>
            r && (r.frameId !== frame.id || r.selector !== selector) ? r : { frameId: frame.id, selector, info: next },
          )
      })
      .catch(console.error)
  }

  function apply(styles: LayerStyles) {
    if (info) updateRead(styleElement(frame.id, selector, typeof styles === 'function' ? styles(info) : styles))
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

  /* closing the panel is only that: the element stays picked, its outline
     and grips in place, and later picks leave it closed until the rail's
     button opens it again */
  function close() {
    useStore.getState().closeElementPanel()
  }

  const name = node ? layerName(node) : selector.split(' > ').at(-1)
  const parentLabel = parentNode ? `${parentNode.tag}${parentNode.detail}` : 'body'

  return (
    <Panel
      surface={surface}
      className={cn(
        'w-[244px]',
        surface === 'floating' ? 'top-2.5 max-h-[calc(100%-24px)] transition-[right] duration-150' : 'border-l',
        className,
      )}
      style={style}
    >
      <PanelTabsRoot
        value={prototypeMode ? 'prototype' : tab}
        onValueChange={(v) => {
          /* the Prototype tab is Prototype mode: picking it (or the tool
             rail's mode switch) turns the canvas connectors on as well */
          useStore.getState().setPrototypeMode(v === 'prototype')
          if (v !== 'prototype') selectTab(v === 'html' ? 'html' : 'design')
        }}
      >
        <PanelHeader className="pl-2">
          <PanelTabs>
            <PanelTab value="design">{t('inspector.tabDesign')}</PanelTab>
            <PanelTab value="html">{t('inspector.tabHtml')}</PanelTab>
            <PanelTab value="prototype">{t('inspector.tabPrototype')}</PanelTab>
          </PanelTabs>
          <PanelClose onClick={close} />
        </PanelHeader>
        <div className="flex flex-none items-center gap-[7px] border-b border-line-soft px-3 py-2.5">
          <span className="grid size-5 flex-none place-items-center text-ink-faint">
            <LayerKindIcon kind={node?.kind ?? 'box'} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
            {multiple && tab === 'design' && !prototypeMode
              ? t('inspector.selectedLayerCount', { count: picks.length })
              : name}
            {(!multiple || tab !== 'design' || prototypeMode) && (
              <small className="ml-[5px] text-[11px] font-normal text-ink-faint">
                {t('inspector.inParent', { parent: parentLabel })}
              </small>
            )}
          </span>
          {parentNode && (
            <Tooltip label={t('inspector.selectParent')} side="bottom" align="end">
              <Button
                variant="bare"
                size="icon-sm"
                className="size-[22px] text-ink-faint hover:bg-paper-deep hover:text-ink"
                aria-label={t('inspector.selectParent')}
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
            {!multiple && <ComponentSection frame={frame} selector={selector} />}
            {multiple ? (
              <PickedDesign key={JSON.stringify([frame.id, picks])} frame={frame} picks={picks} />
            ) : info ? (
              <PropertyScrubContext.Provider
                value={{ onStart: () => scrub('begin'), onEnd: (cancel) => scrub(cancel ? 'cancel' : 'commit') }}
              >
                <DesignTab
                  key={`${frame.id}:${selector}`}
                  frame={frame}
                  selector={selector}
                  info={info}
                  apply={apply}
                  editGeometry={editGeometry}
                />
              </PropertyScrubContext.Provider>
            ) : standIn ? (
              /* React 18 does not know `inert`, so it goes on by hand */
              <div aria-busy="true" ref={(el) => el?.setAttribute('inert', '')}>
                <DesignTab
                  key={`${standIn.frameId}:${standIn.selector}`}
                  frame={frame}
                  selector={standIn.selector}
                  info={standIn.info}
                  apply={() => {}}
                  editGeometry={() => {}}
                />
              </div>
            ) : (
              <Waiting hasText={hasText} />
            )}
            {!multiple && <LayerExportSection frame={frame} target={{ selector, name: name ?? 'element' }} />}
          </PanelBody>
        </PanelTabPanel>
        <PanelTabPanel value="html">
          <HtmlTab key={`${frame.id}:${selector}`} frame={frame} selector={selector} />
        </PanelTabPanel>
        <PanelTabPanel value="prototype">
          <PanelBody>
            <InteractionsPanel frame={frame} selector={selector} />
          </PanelBody>
        </PanelTabPanel>
      </PanelTabsRoot>
    </Panel>
  )
}

const LOADING_SECTIONS: { title: PlainMessageKey; rows: PlainMessageKey[] }[] = [
  { title: 'inspector.sectionPosition', rows: ['inspector.rowType', 'inspector.rowOrder'] },
  { title: 'inspector.sectionLayout', rows: ['inspector.rowMinWidth', 'inspector.rowDisplay', 'inspector.rowGap'] },
  { title: 'inspector.sectionAppearance', rows: ['inspector.rowOpacity', 'inspector.rowRadius'] },
  { title: 'inspector.sectionFill', rows: ['inspector.rowColor'] },
  { title: 'inspector.sectionStroke', rows: ['inspector.rowColor', 'inspector.rowWidth'] },
  {
    title: 'inspector.sectionText',
    rows: ['inspector.rowFont', 'inspector.rowSize', 'inspector.rowWeight', 'inspector.rowColor', 'inspector.rowAlign'],
  },
]

function Waiting({ hasText }: { hasText: boolean }) {
  const t = useT()
  return (
    <div aria-busy="true">
      <span role="status" className="sr-only">
        {t('inspector.readingElement')}
      </span>
      <div aria-hidden="true">
        {LOADING_SECTIONS.filter((section) => section.title !== 'inspector.sectionText' || hasText).map((section) => (
          <PropertySection key={section.title} title={t(section.title)}>
            {section.rows.map((label) => (
              <PropertyRow key={label} label={t(label)}>
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
  { axis: 'x', edge: 'start', label: 'inspector.alignLayerLeft', Icon: AlignStartVerticalIcon },
  { axis: 'x', edge: 'center', label: 'inspector.centerLayerHorizontally', Icon: AlignCenterVerticalIcon },
  { axis: 'x', edge: 'end', label: 'inspector.alignLayerRight', Icon: AlignEndVerticalIcon },
  { axis: 'y', edge: 'start', label: 'inspector.alignLayerTop', Icon: AlignStartHorizontalIcon },
  { axis: 'y', edge: 'center', label: 'inspector.centerLayerVertically', Icon: AlignCenterHorizontalIcon },
  { axis: 'y', edge: 'end', label: 'inspector.alignLayerBottom', Icon: AlignEndHorizontalIcon },
] as const
const ALIGNS: { value: string; label: PlainMessageKey; Icon: typeof AlignLeftIcon }[] = [
  { value: 'left', label: 'inspector.alignLeft', Icon: AlignLeftIcon },
  { value: 'center', label: 'inspector.alignCenter', Icon: AlignCenterIcon },
  { value: 'right', label: 'inspector.alignRight', Icon: AlignRightIcon },
  { value: 'justify', label: 'inspector.justify', Icon: AlignJustifyIcon },
]
const BORDER_SIDES: Record<string, PlainMessageKey> = {
  top: 'inspector.sideTop',
  right: 'inspector.sideRight',
  bottom: 'inspector.sideBottom',
  left: 'inspector.sideLeft',
}

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
 *  frame alongside system faces that need no additional font download. The
 *  canvas's custom fonts lead, in a group of their own; picking one is all it
 *  takes, since the save adds its @font-face to the frame. */
function fontOptions(
  info: ElementInfo,
  custom: readonly string[],
  groups: { custom: string; frame: string; web: string; device: string },
  deviceLabel: (key: PlainMessageKey) => string,
) {
  const current = fontName(info.fontFamily).toLowerCase()
  const library = custom.map((family) => ({
    /* the computed stack, when it is this family, so the select shows it */
    value: family.toLowerCase() === current ? info.fontFamily : fontStack(family),
    label: family,
    group: groups.custom,
  }))
  const frame = [info.fontFamily, ...info.fontFamilies].map((value) => ({
    value,
    label: fontName(value),
    group: groups.frame,
  }))
  const web = WEB_FONTS.map((font) => ({
    value: font.family.toLowerCase() === current ? info.fontFamily : webFontStack(font),
    label: font.family,
    group: groups.web,
  }))
  const device = DEVICE_FONTS.map((o) => ({ value: o.value, label: deviceLabel(o.label), group: groups.device }))
  const seen = new Set<string>()
  return [...library, ...frame, ...web, ...device].filter(({ value }) => {
    const family = fontName(value).toLowerCase()
    if (seen.has(family)) return false
    seen.add(family)
    return true
  })
}
const SIZE_MODES: { value: SizeMode; label: PlainMessageKey }[] = [
  { value: 'auto', label: 'inspector.sizeAuto' },
  { value: 'fixed', label: 'inspector.sizeFixed' },
  { value: 'fill', label: 'inspector.sizeFill' },
  { value: 'hug', label: 'inspector.sizeHug' },
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

/** The token a property is bound to inline, if any. */
/** The properties the Fill and Stroke sections write: SVG paint on a vector,
 *  the box's background and border elsewhere. */
function paintProperties(info: Pick<ElementInfo, 'vector'>) {
  return info.vector ? { fill: 'fill', stroke: 'stroke' } : { fill: 'background-color', stroke: 'border-color' }
}

function boundToken(
  info: Pick<ElementInfo, 'inline'>,
  property: string,
  tokens: readonly DesignToken[],
): DesignToken | undefined {
  const name = aliasOf(info.inline[property] ?? '')
  return name ? tokens.find((token) => token.name === name) : undefined
}

/** What a field shows while bound: the token's name, and its colour for a swatch. */
function fieldToken(
  token: DesignToken | undefined,
  tokens: readonly DesignToken[],
  theme: string | undefined,
  detach: () => void,
): FieldToken | undefined {
  if (!token) return undefined
  return {
    name: tokenLabel(token.name),
    ...(token.type === 'color'
      ? { swatch: resolveToken(tokens, token.name, theme) ?? effectiveValue(token, theme) }
      : {}),
    onDetach: detach,
  }
}

/** The trailing menu of a field: a popover listing the canvas's tokens of
 *  the field's types; its + opens a card beside it that makes a new token
 *  from the field's current value and binds the field to it. */
function TokenMenu({
  canvasId,
  types,
  tokens,
  theme,
  literal,
  onPick,
  placement = 'inline',
}: {
  canvasId: string
  types: readonly TokenType[]
  tokens: readonly DesignToken[]
  /** the frame's theme: values and swatches are shown as that theme resolves them */
  theme?: string
  /** the field's current value, what a new token is made from; null when there is none */
  literal: string | null
  onPick: (name: string) => void
  /** `inline` sits inside a field and shows on hover; `beside` is a field-height box next to a select */
  placement?: 'inline' | 'beside'
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const type = types[0]!
  const options = sortTokens(tokens.filter((token) => types.includes(token.type)))
  const typed = normalizeTokenName(name)
  const canCreate = isTokenName(typed) && value.trim() !== '' && !busy

  function startCreating() {
    setValue(literal ?? '')
    setName(tokenLabel(nextTokenName(tokens, type)))
    setError(null)
    setCreating(true)
  }

  function close() {
    setOpen(false)
    setCreating(false)
  }

  async function create() {
    if (!canCreate) return
    setBusy(true)
    setError(null)
    try {
      const { results, tokens: next } = await api.createTokens(canvasId, [{ name: typed, type, value: value.trim() }])
      const [result] = results
      if (result?.result === 'error') throw new Error(result.message)
      /* the room will send the same list; applying it now shows the chip at once */
      const state = useStore.getState()
      if (state.canvas?.id === canvasId) state.setTokensLocal(next, state.canvas.tokenThemes ?? [])
      onPick(typed)
      close()
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^\d+\s*/, '') : t('inspector.tokenCreateFailed'))
    } finally {
      setBusy(false)
    }
  }

  const swatch = type === 'color' && /^(#|rgb|hsl|oklch|oklab|color\()/i.test(value.trim())
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setCreating(false)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('inspector.tokenPick')}
          title={t('inspector.tokenPick')}
          className={
            placement === 'beside'
              ? 'grid size-[26px] flex-none place-items-center rounded-[7px] bg-sub text-ink-faint hover:bg-paper-deep hover:text-ink data-[state=open]:bg-paper-deep data-[state=open]:text-ink'
              : 'grid size-5 flex-none place-items-center rounded-[5px] text-ink-faint opacity-0 transition-opacity hover:bg-paper-deep hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:bg-paper-deep data-[state=open]:text-ink data-[state=open]:opacity-100'
          }
        >
          <BracesIcon size={placement === 'beside' ? 12 : 11} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[220px] p-1.5">
        <div className="flex h-6 items-center justify-between pr-0.5 pl-2">
          <span className="text-[11px] text-ink-faint">{t('inspector.tokenHeading')}</span>
          {literal !== null && (
            <Popover open={creating} onOpenChange={(next) => (next ? startCreating() : setCreating(false))}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={t('inspector.tokenCreate')}
                  title={t('inspector.tokenCreate')}
                  className="grid size-5 place-items-center rounded-[5px] text-ink-faint hover:bg-paper-deep hover:text-ink data-[state=open]:bg-paper-deep data-[state=open]:text-ink"
                >
                  <PlusIcon size={12} />
                </button>
              </PopoverTrigger>
              {/* beside the list, Figma's "create variable" sheet; a nested
                  popover so it stays inside the viewport like the list does */}
              <PopoverContent side="left" align="start" sideOffset={14} className="w-[220px] p-2.5">
                <form
                  className="flex flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void create()
                  }}
                >
                  <span className="px-0.5 text-[11px] text-ink-faint">
                    {t('inspector.tokenNewTitle', { type: t(TOKEN_TYPE_LABEL[type]).toLowerCase() })}
                  </span>
                  <label className="flex h-7 items-center gap-1.5 rounded-[7px] bg-sub px-2 focus-within:bg-surface focus-within:shadow-elevation-1-focus">
                    <span className="w-10 flex-none text-[10.5px] text-ink-faint">{t('inspector.tokenName')}</span>
                    <input
                      aria-label={t('inspector.tokenNewName')}
                      autoFocus
                      className="w-full min-w-0 bg-transparent font-mono text-[11px] text-ink outline-none"
                      value={name}
                      disabled={busy}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <label className="flex h-7 items-center gap-1.5 rounded-[7px] bg-sub px-2 focus-within:bg-surface focus-within:shadow-elevation-1-focus">
                    <span className="w-10 flex-none text-[10.5px] text-ink-faint">{t('inspector.tokenValue')}</span>
                    {swatch && (
                      <span
                        className="size-3 flex-none rounded-[3px] border border-line"
                        style={{ background: value }}
                      />
                    )}
                    <input
                      aria-label={t('inspector.tokenValue')}
                      className="w-full min-w-0 bg-transparent font-mono text-[11px] text-ink outline-none"
                      value={value}
                      disabled={busy}
                      onChange={(e) => setValue(e.target.value)}
                    />
                  </label>
                  {error && <p className="px-0.5 text-[10.5px] text-accent-ink">{error}</p>}
                  <button
                    type="submit"
                    disabled={!canCreate}
                    className="h-7 rounded-[7px] bg-ink text-[11.5px] font-medium text-paper disabled:opacity-30"
                  >
                    {busy ? t('inspector.tokenCreating') : t('inspector.tokenCreateButton')}
                  </button>
                </form>
              </PopoverContent>
            </Popover>
          )}
        </div>
        {options.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] leading-[1.4] text-ink-faint">
            {literal === null ? t('inspector.tokenNone') : t('inspector.tokenNoneCreate')}
          </p>
        ) : (
          <div
            role="listbox"
            aria-label={t('inspector.tokenPick')}
            className="flex max-h-[220px] flex-col overflow-y-auto"
          >
            {options.map((token) => (
              <button
                key={token.name}
                type="button"
                role="option"
                aria-selected={false}
                className="flex h-7 items-center gap-2 rounded-[7px] px-2 text-left hover:bg-sub"
                onClick={() => {
                  onPick(token.name)
                  close()
                }}
              >
                <TokenSwatch token={token} tokens={tokens} size={12} theme={theme} />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">{tokenLabel(token.name)}</span>
                <span className="max-w-[40%] flex-none truncate font-mono text-[10.5px] text-ink-faint">
                  {effectiveValue(token, theme)}
                </span>
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** What the Fill and Stroke sections read: the layer's paint and the inline
 *  values its token bindings sit on. */
type PaintInfo = Pick<ElementInfo, 'backgroundColor' | 'inline' | 'vector'>

/** A field bound to a token shows its name (`chip`); the menu beside it
 *  binds one (`menu`). A vector's paint lives on its shapes, so its token
 *  bindings do too. Swatches and values read as the frame's theme resolves them. */
function useTokenFields<T extends PaintInfo>(
  frame: Frame,
  selection: T[],
  apply: (patch: (info: T) => StylePatch) => void,
) {
  const tokens = useStore((state) => state.canvas?.tokens ?? [])
  const bound = (property: string) =>
    commonValue(selection, (info) =>
      boundToken(info.vector ? { inline: { ...info.inline, ...info.vector.inline } } : info, property, tokens),
    ) ?? undefined
  const theme = frameTheme(frame.html) ?? undefined
  const chip = (property: string, literal: (info: T) => string | null) =>
    fieldToken(bound(property), tokens, theme, () => apply((el) => ({ [property]: literal(el) })))
  const menu = (
    property: string,
    types: readonly TokenType[],
    literal: (info: T) => string | null,
    placement: 'inline' | 'beside' = 'inline',
    /** written with the binding: the side effects the literal control has */
    extra: StylePatch = {},
  ) => (
    <TokenMenu
      canvasId={frame.canvasId}
      types={types}
      tokens={tokens}
      theme={theme}
      literal={commonValue(selection, literal)}
      placement={placement}
      onPick={(name) => apply(() => ({ [property]: `var(${name})`, ...extra }))}
    />
  )
  return { tokens, bound, chip, menu }
}

/* a colour and its number (fill opacity, stroke width): the number's column
   fits "100 %" and a two-digit "12 px" whole, the same in every such row */
const COLOR_ROW = 'grid grid-cols-[minmax(0,1fr)_72px] gap-1.5'

function fillOf(info: PaintInfo) {
  const fillColor = info.vector ? info.vector.fill : info.backgroundColor
  const fill = rgbToHex(fillColor, true)
  const fillAlpha = info.vector && fillColor === 'none' ? 0 : colorAlpha(fillColor) * (info.vector?.fillOpacity ?? 1)
  return { fill, fillColor, fillAlpha }
}

function fillPatch(info: PaintInfo, color: string | null, alpha: number): StylePatch {
  if (!info.vector) return { 'background-color': color ? colorWithAlpha(color, alpha) : 'transparent' }
  if (!color) return { fill: 'none' }
  return { fill: rgbToHex(color) ?? color, 'fill-opacity': String(Math.min(1, Math.max(0, alpha))) }
}

/** The Fill section: the paint's colour and opacity, token-bindable, and an
 *  image fill when the layer has one. The frame Inspector shows the same
 *  section for the frame's own fill. */
export function FillSection({
  frame,
  selector,
  info,
  apply,
  selection: picked,
  applyEach,
}: {
  frame: Frame
  selector: string
  info: PaintInfo & { image?: ElementInfo['image'] }
  selection?: PaintInfo[]
  applyEach?: (patch: (info: PaintInfo) => StylePatch) => void
  apply: (styles: StylePatch) => void
}) {
  const selection = picked ?? [info]
  const t = useT()
  const paint = paintProperties(info)
  const samePaint = selection.every((el) => !!el.vector === !!info.vector)
  const shown = commonValue(selection, (item) => {
    const { fill, fillAlpha } = fillOf(item)
    return fillAlpha === 0 && fill === '#000000' ? '' : (fill ?? '')
  })
  const alpha = commonValue(selection, (item) => Math.round(fillOf(item).fillAlpha * 100))
  const editPaint = (patch: (item: PaintInfo) => StylePatch) => {
    if (applyEach) applyEach(patch)
    else apply(patch(info))
  }
  /* the fill as the document has it: a translucent one keeps its alpha */
  const fillLiteral = (el: PaintInfo) => {
    const { fill, fillAlpha, fillColor } = fillOf(el)
    return fill && fillAlpha < 1 ? fillColor : fill
  }
  const { chip, menu } = useTokenFields(frame, selection, editPaint)
  return (
    <PropertySection title={t('inspector.sectionFill')}>
      {!picked && info.image && (
        <ImageFill key={`${frame.id}:${selector}`} frame={frame} selector={selector} image={info.image} apply={apply} />
      )}
      <div className={COLOR_ROW}>
        <ColorField
          label={t('inspector.fillColor')}
          commitPickerOnChange={!!picked}
          value={shown || null}
          mixed={shown === null}
          placeholder={shown === null ? t('inspector.mixed') : undefined}
          token={samePaint ? chip(paint.fill, fillLiteral) : undefined}
          trailing={
            samePaint &&
            menu(
              paint.fill,
              ['color'],
              fillLiteral,
              'inline',
              /* a token carries its own alpha: a vector's earlier fill-opacity goes */
              info.vector ? { 'fill-opacity': '1' } : {},
            )
          }
          onCommit={(v) =>
            editPaint((item) => {
              const { fill, fillAlpha } = fillOf(item)
              return fillPatch(item, v, fillAlpha === 0 && (!fill || fill === '#000000') ? 1 : fillAlpha)
            })
          }
        />
        <NumberField
          label={t('inspector.fillOpacity')}
          prefix={<DropletIcon size="rail" />}
          max={100}
          slider={[0, 100]}
          value={alpha}
          placeholder={t('inspector.mixed')}
          unit="%"
          onCommit={(v) =>
            editPaint((item) => {
              const { fill, fillColor } = fillOf(item)
              return item.vector && !fill
                ? { 'fill-opacity': String(v / 100) }
                : fillPatch(item, fill ?? fillColor, v / 100)
            })
          }
        />
      </div>
    </PropertySection>
  )
}

type LayerStyles = StylePatch | ((info: ElementInfo) => StylePatch)

function PickedDesign({ frame, picks }: { frame: Frame; picks: string[] }) {
  const [layers, setLayers] = useState<InspectedLayer[] | null>(null)
  const t = useT()
  const request = useRef(0)
  const scrubbing = useRef(false)
  const targets = useMemo(() => picks.map((selector) => ({ selector })), [picks])
  const send = useCallback(
    (edits: PickedLayerEdit[], phase: PanelEditPhase) => {
      const id = ++request.current
      void editPickedLayers(frame.id, edits, phase)
        .then((next) => {
          if (id === request.current && next) setLayers(next)
        })
        .catch(console.error)
    },
    [frame.id],
  )
  useEffect(() => {
    send(targets, 'read')
    let timer: number | undefined
    const off = onFrameChange(frame.id, () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => send(targets, 'read'), INSPECT_DELAY_MS)
    })
    return () => {
      off()
      window.clearTimeout(timer)
    }
  }, [frame.id, frame.html, targets, send])

  if (!layers) return <Waiting hasText={false} />
  const primary = layers.at(-1)
  if (!primary) return <StaticField>{t('inspector.noEditableLayers')}</StaticField>
  const editable = layers.map(({ selector }) => ({ selector }))
  const phase = () => (scrubbing.current ? 'preview' : 'apply')
  return (
    <PropertyScrubContext.Provider
      value={{
        onStart: () => {
          scrubbing.current = true
          send(editable, 'begin')
        },
        onEnd: (cancel) => {
          scrubbing.current = false
          send(editable, cancel ? 'cancel' : 'commit')
        },
      }}
    >
      {layers.length < picks.length && (
        <p className="px-3 py-1.5 text-caption text-ink-faint">
          {t('inspector.editableLayerCount', { editable: layers.length, total: picks.length })}
        </p>
      )}
      <DesignTab
        frame={frame}
        selector={primary.selector}
        info={primary.info}
        selection={layers.map(({ info }) => info)}
        apply={(styles) =>
          send(
            layers.map(({ selector, info }) => ({
              selector,
              styles: typeof styles === 'function' ? styles(info) : styles,
            })),
            phase(),
          )
        }
        editGeometry={(geometry) =>
          send(
            editable.map(({ selector }) => ({ selector, geometry })),
            phase(),
          )
        }
      />
    </PropertyScrubContext.Provider>
  )
}

function sizing(info: ElementInfo) {
  const ratio = aspectRatio(info.aspectRatio, info.naturalAspectRatio)
  const flexAxis = flexSizeAxis(info)
  function modeFor(axis: 'width' | 'height') {
    return flexAxis === axis && (info.flexGrow ?? 0) > 0 ? 'fill' : sizeMode(info[`${axis}Value`])
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
  function setSize(axis: 'width' | 'height', mode: SizeMode, value = info[axis] ?? 0): StylePatch {
    const other = axis === 'width' ? 'height' : 'width'
    const paired = ratio === null ? {} : automaticSize(other)
    const flex: StylePatch = axis === flexAxis ? { 'flex-grow': '0', 'flex-shrink': '0', 'flex-basis': 'auto' } : {}
    if (mode === 'fixed') {
      return {
        ...fixedSize(axis, value),
        ...(ratio === null ? {} : fixedSize(other, axis === 'width' ? value / ratio : value * ratio)),
      }
    } else if (mode === 'fill' && axis === flexAxis) {
      return {
        ...paired,
        [axis]: 'auto',
        'flex-grow': '1',
        'flex-shrink': '1',
        'flex-basis': '0px',
        [`min-${axis}`]: '0px',
      }
    } else if (mode === 'fill') {
      // A 100% content box would overflow by its own padding and borders.
      const extra = info.boxSizing === 'border-box' ? 0 : info.boxExtras[axis]
      return { ...paired, [axis]: extra ? `calc(100% - ${extra}px)` : '100%' }
    } else return { ...paired, ...flex, [axis]: mode === 'hug' ? 'fit-content' : 'auto' }
  }
  function setLinked(linked: boolean): StylePatch {
    if (linked) {
      return {
        'aspect-ratio': `${info.width} / ${info.height}`,
        ...(modeFor('width') === 'fill'
          ? automaticSize('height')
          : modeFor('height') === 'fill'
            ? automaticSize('width')
            : {}),
      }
    }
    // Preserve dimensions that CSS derived from the ratio, including authored
    // auto/fit-content, while keeping existing fixed and Fill sizes responsive.
    return {
      'aspect-ratio': 'auto',
      ...(['auto', 'hug'].includes(modeFor('width')) && info.width !== null ? fixedSize('width', info.width) : {}),
      ...(['auto', 'hug'].includes(modeFor('height')) && info.height !== null ? fixedSize('height', info.height) : {}),
    }
  }
  return { modeFor, setSize, setLinked }
}

function DesignTab({
  frame,
  selector,
  info,
  apply,
  editGeometry,
  selection: picked,
}: {
  frame: Frame
  selector: string
  info: ElementInfo
  selection?: ElementInfo[]
  apply: (styles: LayerStyles) => void
  editGeometry: (edit: GeometryEdit) => void
}) {
  const selection = picked ?? [info]
  const library = useCanvasFonts((state) => state.fonts)
  const customFamilies = libraryFamilies(library)
  const { tokens, bound, chip, menu } = useTokenFields(frame, selection, apply)

  /* a library family offers only the weights it was uploaded with; picking
     one it lacks would just show the browser's faux bold */
  const weights = familyWeights(library, fontName(info.fontFamily)) ?? WEIGHTS
  /* runs that disagree show "Mixed", as Figma does for a text layer */
  const textMixed = (key: 'fontSize' | 'fontWeight' | 'fontFamily' | 'color') =>
    selection.some((el) => el.textMixed?.[key] || el[key] !== info[key])
  const t = useT()
  const multiple = !!picked
  const common = <V,>(read: (el: ElementInfo) => V) => commonValue(selection, read)
  const placeholder = multiple ? t('inspector.mixed') : undefined
  const sizeModes = SIZE_MODES.map(({ value, label }) => ({ value, label: t(label) }))
  const linked = common((el) => aspectRatio(el.aspectRatio, el.naturalAspectRatio) !== null)
  const canLink = selection.every((el) => (el.width ?? 0) > 0 && (el.height ?? 0) > 0)
  const visible = common((el) => el.visibility !== 'hidden')
  const clipped = common((el) => el.clipsContent)
  /* A vector layer (a drawn or imported path, an inline icon) paints with
     SVG's fill and stroke, as Figma's vectors do; any other layer with its
     box's background and border. */
  const paint = paintProperties(info)
  const sharedStroke = common((el) => rgbToHex(el.vector ? el.vector.stroke : el.borderColor) ?? '')
  const sameStroke = selection.every(
    (el) => !!el.vector === !!info.vector && (el.borderStyle === 'none') === (info.borderStyle === 'none'),
  )
  const strokeOn: StylePatch = !info.vector && info.borderStyle === 'none' ? { 'border-style': 'solid' } : {}
  /* the stroke and text colours as the document has them: a translucent one keeps its alpha */
  const colorLiteral = (color: string) => (colorAlpha(color) < 1 ? color : rgbToHex(color))
  const strokeLiteral = (el: ElementInfo) => colorLiteral(el.vector ? el.vector.stroke : el.borderColor)
  const textLiteral = (el: ElementInfo) => colorLiteral(el.color)
  const radiusLiteral = (el: ElementInfo) => (el.borderRadius === null ? null : `${el.borderRadius}px`)
  const sizeLiteral = (el: ElementInfo) => (el.fontSize === null ? null : `${el.fontSize}px`)
  const minWidth = common((el) => el.inline['min-width'] ?? (el.minWidth === '0px' ? '' : el.minWidth))
  const isFlex = selection.every((el) => el.display === 'flex' || el.display === 'inline-flex')
  const border = borderSummary(info.borderWidths)
  const textAlign =
    common((el) =>
      el.textAlign === 'start'
        ? el.direction === 'rtl'
          ? 'right'
          : 'left'
        : el.textAlign === 'end'
          ? el.direction === 'rtl'
            ? 'left'
            : 'right'
          : el.textAlign,
    ) ?? ''
  return (
    <>
      <PropertySection title={t('inspector.sectionAlignment')}>
        <div className="flex gap-1" role="group" aria-label={t('inspector.layerAlignment')}>
          {LAYER_ALIGNS.map(({ axis, edge, label, Icon }) => (
            <Button
              key={`${axis}-${edge}`}
              variant="bare"
              size="icon-sm"
              className="h-[26px] min-w-0 flex-1 rounded-[7px] bg-sub text-ink-soft hover:bg-paper-deep"
              aria-label={t(label)}
              title={t('inspector.withinParent', { label: t(label) })}
              disabled={!selection.every((el) => el.geometry.canAlign)}
              onClick={() => editGeometry({ kind: 'align', axis, edge })}
            >
              <Icon size="rail" />
            </Button>
          ))}
        </div>
      </PropertySection>
      <PropertySection title={t('inspector.sectionPosition')}>
        <div className="grid grid-cols-2 gap-1.5" title={t('inspector.positionTitle')}>
          <NumberField
            label={t('inspector.xPosition')}
            min={-Infinity}
            prefix="X"
            value={common((el) => el.geometry.x)}
            placeholder={placeholder}
            unit="px"
            disabled={!selection.every((el) => el.geometry.enabled)}
            onCommit={(value) => editGeometry({ kind: 'position', axis: 'x', value })}
          />
          <NumberField
            label={t('inspector.yPosition')}
            min={-Infinity}
            prefix="Y"
            value={common((el) => el.geometry.y)}
            placeholder={placeholder}
            unit="px"
            disabled={!selection.every((el) => el.geometry.enabled)}
            onCommit={(value) => editGeometry({ kind: 'position', axis: 'y', value })}
          />
        </div>
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          <NumberField
            label={t('inspector.rotation')}
            min={-Infinity}
            prefix={<RotationIcon size="rail" />}
            value={common((el) => el.geometry.rotation)}
            placeholder={placeholder}
            unit="°"
            disabled={!selection.every((el) => el.geometry.enabled)}
            onCommit={(value) => editGeometry({ kind: 'rotate', value })}
          />
          <div className="grid grid-cols-2 gap-1.5">
            {(['x', 'y'] as const).map((axis) => {
              const Icon = axis === 'x' ? FlipHorizontal2Icon : FlipVertical2Icon
              const label = axis === 'x' ? t('inspector.flipHorizontally') : t('inspector.flipVertically')
              const pressed = common((el) => (axis === 'x' ? el.geometry.scaleX : el.geometry.scaleY) < 0)
              return (
                <Button
                  key={axis}
                  variant="bare"
                  size="icon-sm"
                  aria-label={label}
                  title={label}
                  aria-pressed={pressed ?? 'mixed'}
                  disabled={!selection.every((el) => el.geometry.enabled)}
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
        <PropertyRow label={t('inspector.rowType')}>
          <SelectField
            label={t('inspector.positionType')}
            value={common((el) => el.position)}
            placeholder={placeholder}
            options={POSITIONS.map((p) => ({ value: p, label: p }))}
            onChange={(v) => apply({ position: v })}
          />
        </PropertyRow>
        {!multiple && (
          <PropertyRow label={t('inspector.rowOrder')}>
            <StaticField>
              {info.index}
              <FieldUnit>
                {t('inspector.orderOf', { count: info.count })}
                {parentLayout(info) && ` · ${parentLayout(info)}`}
              </FieldUnit>
            </StaticField>
          </PropertyRow>
        )}
      </PropertySection>
      <PropertySection
        title={t('inspector.sectionLayout')}
        action={
          <Tooltip
            label={
              linked === true
                ? t('inspector.unlinkSize')
                : canLink
                  ? t('inspector.linkSize')
                  : t('inspector.linkSizeDisabled')
            }
          >
            <span>
              <Button
                variant="bare"
                size="icon-sm"
                className={cn(
                  'size-5 rounded-tag',
                  linked === true ? 'bg-ink text-paper hover:bg-ink/85 hover:text-paper' : 'text-ink-faint',
                )}
                aria-label={t('inspector.linkSize')}
                aria-pressed={linked ?? 'mixed'}
                disabled={linked !== true && !canLink}
                onClick={() => apply((el) => sizing(el).setLinked(linked !== true))}
              >
                {linked === true ? <LinkIcon size="rail" /> : <UnlinkIcon size="rail" />}
              </Button>
            </span>
          </Tooltip>
        }
      >
        <div className="grid grid-cols-2 gap-1.5">
          {(['width', 'height'] as const).map((axis) => (
            <div key={axis} className="flex min-w-0 flex-col gap-1">
              <NumberField
                label={axis === 'width' ? t('inspector.width') : t('inspector.height')}
                prefix={axis === 'width' ? 'W' : 'H'}
                value={common((el) => el[axis])}
                placeholder={placeholder}
                unit="px"
                onCommit={(v) => apply((el) => sizing(el).setSize(axis, 'fixed', v))}
              />
              <SelectField
                label={axis === 'width' ? t('inspector.widthSizing') : t('inspector.heightSizing')}
                value={common((el) => sizing(el).modeFor(axis))}
                placeholder={placeholder}
                options={sizeModes}
                onChange={(v) => apply((el) => sizing(el).setSize(axis, v))}
              />
            </div>
          ))}
        </div>
        <PropertyRow label={t('inspector.rowMinWidth')}>
          <LengthField
            label={t('inspector.minimumWidth')}
            value={minWidth}
            placeholder={minWidth === null ? t('inspector.mixed') : 'auto'}
            onCommit={(v) => apply({ 'min-width': lengthValue(v) })}
          />
        </PropertyRow>
        <PropertyRow label={t('inspector.rowDisplay')}>
          <SelectField
            label={t('inspector.display')}
            value={common(displayValue)}
            placeholder={placeholder}
            options={DISPLAYS}
            onChange={(v) => apply({ display: v })}
          />
        </PropertyRow>
        {!isFlex && (
          <>
            {selection.every((el) => el.display.includes('grid')) && (
              <PropertyRow label={t('inspector.rowGap')}>
                <NumberField
                  label={t('inspector.rowGapLabel')}
                  prefix={<RowGapIcon size="rail" />}
                  value={common((el) => el.rowGap ?? 0)}
                  placeholder={placeholder}
                  unit="px"
                  onCommit={(v) => apply({ 'row-gap': `${Math.max(0, v)}px` })}
                />
                <NumberField
                  label={t('inspector.columnGap')}
                  prefix={<ColumnGapIcon size="rail" />}
                  value={common((el) => el.columnGap ?? 0)}
                  placeholder={placeholder}
                  unit="px"
                  onCommit={(v) => apply({ 'column-gap': `${Math.max(0, v)}px` })}
                />
              </PropertyRow>
            )}
            <PaddingControls selection={selection} apply={apply} />
          </>
        )}
      </PropertySection>
      {isFlex && <FlexLayoutControls selection={selection} apply={apply} />}
      <PropertySection
        title={t('inspector.sectionAppearance')}
        action={
          <Button
            variant="bare"
            size="icon-sm"
            className="size-5 rounded-tag text-ink-faint"
            aria-label={visible === false ? t('inspector.showElement') : t('inspector.hideElement')}
            title={visible === false ? t('inspector.showElement') : t('inspector.hideElement')}
            aria-pressed={visible === null ? 'mixed' : !visible}
            onClick={() => apply({ visibility: visible === false ? 'visible' : 'hidden' })}
          >
            {visible !== false ? <EyeIcon size="rail" /> : <EyeClosedIcon size="rail" />}
          </Button>
        }
      >
        <div className="grid grid-cols-2 gap-1.5">
          <NumberField
            label={t('inspector.elementOpacity')}
            max={100}
            slider={[0, 100]}
            prefix={<DropletIcon size="rail" />}
            value={common((el) => (el.opacity === null ? null : Math.round(el.opacity * 100)))}
            placeholder={placeholder}
            unit="%"
            onCommit={(v) => apply({ opacity: String(Math.min(100, Math.max(0, v)) / 100) })}
          />
          <NumberField
            label={t('inspector.cornerRadius')}
            slider={RADIUS_SLIDE}
            prefix={<RadiusIcon size="rail" />}
            value={common((el) => el.borderRadius)}
            placeholder={placeholder}
            unit="px"
            token={chip('border-radius', radiusLiteral)}
            trailing={menu('border-radius', ['radius'], radiusLiteral)}
            onCommit={(v) => apply({ 'border-radius': `${Math.max(0, v)}px` })}
          />
        </div>
        <label className="mt-2 flex h-5 cursor-pointer items-center justify-between text-[11.5px] text-ink-soft">
          {t('inspector.clipContent')}
          {clipped === null && <span className="ml-auto mr-1 text-ink-faint">{t('inspector.mixed')}</span>}
          <Switch
            size="sm"
            aria-description={clipped === null ? t('inspector.mixed') : undefined}
            aria-label={t('inspector.clipContent')}
            className="data-[state=checked]:bg-ink"
            checked={clipped === true}
            onCheckedChange={(on) => apply({ overflow: on ? 'hidden' : 'visible' })}
          />
        </label>
      </PropertySection>
      <FillSection frame={frame} selector={selector} info={info} selection={picked} apply={apply} applyEach={apply} />
      <PropertySection title={t('inspector.sectionStroke')}>
        <div className={COLOR_ROW}>
          <ColorField
            label={t('inspector.borderColor')}
            commitPickerOnChange={multiple}
            value={sharedStroke || null}
            mixed={sharedStroke === null}
            placeholder={sharedStroke === null ? t('inspector.mixed') : undefined}
            token={sameStroke ? chip(paint.stroke, strokeLiteral) : undefined}
            trailing={sameStroke && menu(paint.stroke, ['color'], strokeLiteral, 'inline', strokeOn)}
            onCommit={(v) =>
              apply((el): StylePatch =>
                el.vector
                  ? { stroke: v ?? 'none' }
                  : { 'border-color': v, ...(v && el.borderStyle === 'none' ? { 'border-style': 'solid' } : {}) },
              )
            }
          />
          <NumberField
            label={t('inspector.borderWidth')}
            prefix={<StrokeWidthIcon size="rail" />}
            value={common((el) => (el.vector ? el.vector.strokeWidth : borderSummary(el.borderWidths).width))}
            placeholder={placeholder}
            unit="px"
            onCommit={(v) =>
              apply((el): StylePatch =>
                el.vector
                  ? { 'stroke-width': `${Math.max(0, v)}px` }
                  : {
                      'border-width': `${Math.max(0, v)}px`,
                      ...(v > 0 && el.borderStyle === 'none' ? { 'border-style': 'solid' } : {}),
                    },
              )
            }
          />
        </div>
        {!multiple && !info.vector && border.sides && (
          <p className="mt-1 text-[10.5px] text-ink-faint">
            {t('inspector.sides', {
              sides: border.sides
                .split(' ')
                .map((side) => {
                  const key = BORDER_SIDES[side]
                  return key ? t(key) : side
                })
                .join(' '),
            })}
          </p>
        )}
      </PropertySection>
      {selection.every((el) => el.hasText) && (
        <PropertySection title={t('inspector.sectionText')}>
          <PropertyRow label={t('inspector.rowFont')}>
            <span className="group flex min-w-0 flex-1 items-center gap-1.5">
              <SelectField
                label={t('inspector.fontFamily')}
                value={
                  bound('font-family') ? info.inline['font-family']! : textMixed('fontFamily') ? null : info.fontFamily
                }
                placeholder={t('inspector.mixed')}
                options={[
                  ...sortTokens(tokens.filter((token) => token.type === 'fontFamily')).map((token) => ({
                    value: `var(${token.name})`,
                    label: tokenLabel(token.name),
                    group: t('inspector.fontGroupTokens'),
                  })),
                  ...fontOptions(
                    info,
                    customFamilies,
                    {
                      custom: t('inspector.fontGroupCustom'),
                      frame: t('inspector.fontGroupFrame'),
                      web: t('inspector.fontGroupWeb'),
                      device: t('inspector.fontGroupDevice'),
                    },
                    t,
                  ),
                ]}
                onChange={(v) => apply({ 'font-family': v })}
              />
              {menu('font-family', ['fontFamily'], (el) => el.fontFamily, 'beside')}
            </span>
          </PropertyRow>
          <PropertyRow label={t('inspector.rowSize')}>
            <NumberField
              label={t('inspector.fontSize')}
              prefix={<TextSizeIcon size="rail" />}
              value={textMixed('fontSize') ? null : info.fontSize}
              placeholder={t('inspector.mixed')}
              unit="px"
              token={chip('font-size', sizeLiteral)}
              trailing={menu('font-size', ['fontSize'], sizeLiteral)}
              onCommit={(v) => apply({ 'font-size': `${v}px` })}
            />
          </PropertyRow>
          <PropertyRow label={t('inspector.rowWeight')}>
            <span className="group flex min-w-0 flex-1 items-center gap-1.5">
              <SelectField
                label={t('inspector.fontWeight')}
                value={
                  bound('font-weight') ? info.inline['font-weight']! : textMixed('fontWeight') ? null : info.fontWeight
                }
                placeholder={t('inspector.mixed')}
                options={[
                  ...sortTokens(tokens.filter((token) => token.type === 'fontWeight')).map((token) => ({
                    value: `var(${token.name})`,
                    label: tokenLabel(token.name),
                    group: t('inspector.fontGroupTokens'),
                  })),
                  ...[...new Set([...weights, info.fontWeight])]
                    .sort((a, b) => Number(a) - Number(b))
                    .map((w) => ({ value: w, label: w })),
                ]}
                onChange={(v) => apply({ 'font-weight': v })}
              />
              {menu('font-weight', ['fontWeight'], (el) => el.fontWeight, 'beside')}
            </span>
          </PropertyRow>
          <PropertyRow label={t('inspector.rowColor')}>
            <ColorField
              value={textMixed('color') ? null : rgbToHex(info.color)}
              commitPickerOnChange={multiple}
              mixed={multiple && textMixed('color')}
              placeholder={t('inspector.mixed')}
              token={chip('color', textLiteral)}
              trailing={menu('color', ['color'], textLiteral)}
              onCommit={(v) => apply({ color: v })}
            />
          </PropertyRow>
          <PropertyRow label={t('inspector.rowAlign')}>
            <Segmented
              aria-label={t('inspector.textAlignment')}
              className="w-full gap-1 rounded-none bg-transparent p-0"
              value={textAlign}
              onValueChange={(v) => apply({ 'text-align': v })}
            >
              {ALIGNS.map(({ value, label, Icon }) => (
                <SegmentedItem
                  key={value}
                  value={value}
                  aria-label={t(label)}
                  title={t(label)}
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
