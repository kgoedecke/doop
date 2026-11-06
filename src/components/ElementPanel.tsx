import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { Frame } from '../../shared/types'
import { useStore } from '../lib/store'
import {
  editElementGeometry,
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
import { useT, type PlainMessageKey } from '../lib/i18n'

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
  const prototypeMode = useStore((s) => s.prototypeMode)
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

  /* closing the panel is only that: the element stays picked, its outline
     and grips in place, and a second click on it opens the panel again */
  function close() {
    useStore.getState().setElementPanelOpen(false)
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
            {name}
            <small className="ml-[5px] text-[11px] font-normal text-ink-faint">
              {t('inspector.inParent', { parent: parentLabel })}
            </small>
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
            {info ? (
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
            ) : (
              <Waiting hasText={hasText} />
            )}
          </PanelBody>
        </PanelTabPanel>
        <PanelTabPanel value="html">
          <HtmlTab key={selector} frame={frame} selector={selector} />
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
function boundToken(info: ElementInfo, property: string, tokens: readonly DesignToken[]): DesignToken | undefined {
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

function DesignTab({
  frame,
  selector,
  info,
  apply,
  editGeometry,
}: {
  frame: Frame
  selector: string
  info: ElementInfo
  apply: (styles: StylePatch) => void
  editGeometry: (edit: GeometryEdit) => void
}) {
  const library = useCanvasFonts((state) => state.fonts)
  const tokens = useStore((state) => state.canvas?.tokens ?? [])
  const customFamilies = libraryFamilies(library)
  /* a field bound to a token shows its name; the menu beside it binds one */
  const bound = (property: string) => boundToken(info, property, tokens)
  /* the frame's theme, so swatches and values read as this frame resolves them */
  const theme = frameTheme(frame.html) ?? undefined
  const chip = (property: string, literal: string | null) =>
    fieldToken(bound(property), tokens, theme, () => apply({ [property]: literal }))
  const menu = (
    property: string,
    types: readonly TokenType[],
    literal: string | null,
    placement: 'inline' | 'beside' = 'inline',
    /** written with the binding: the side effects the literal control has */
    extra: StylePatch = {},
  ) => (
    <TokenMenu
      canvasId={frame.canvasId}
      types={types}
      tokens={tokens}
      theme={theme}
      literal={literal}
      placement={placement}
      onPick={(name) => apply({ [property]: `var(${name})`, ...extra })}
    />
  )

  /* a library family offers only the weights it was uploaded with; picking
     one it lacks would just show the browser's faux bold */
  const weights = familyWeights(library, fontName(info.fontFamily)) ?? WEIGHTS
  /* runs that disagree show "Mixed", as Figma does for a text layer */
  const mixed = info.textMixed ?? {}
  const t = useT()
  const sizeModes = SIZE_MODES.map(({ value, label }) => ({ value, label: t(label) }))
  const ratio = aspectRatio(info.aspectRatio, info.naturalAspectRatio)
  const canLink = (info.width ?? 0) > 0 && (info.height ?? 0) > 0
  const visible = info.visibility !== 'hidden'
  const fill = rgbToHex(info.backgroundColor, true)
  const fillAlpha = colorAlpha(info.backgroundColor)
  const borderColor = rgbToHex(info.borderColor)
  /* the fill as the document has it: a translucent one keeps its alpha */
  const fillLiteral = fill && fillAlpha < 1 ? info.backgroundColor : fill
  const strokeOn: StylePatch = info.borderStyle === 'none' ? { 'border-style': 'solid' } : {}
  /* the stroke and text colours as the document has them: a translucent one keeps its alpha */
  const strokeLiteral = borderColor && colorAlpha(info.borderColor) < 1 ? info.borderColor : borderColor
  const textLiteral = colorAlpha(info.color) < 1 ? info.color : rgbToHex(info.color)
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
              disabled={!info.geometry.canAlign}
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
            value={info.geometry.x}
            unit="px"
            disabled={!info.geometry.enabled}
            onCommit={(value) => editGeometry({ kind: 'position', axis: 'x', value })}
          />
          <NumberField
            label={t('inspector.yPosition')}
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
            label={t('inspector.rotation')}
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
              const label = axis === 'x' ? t('inspector.flipHorizontally') : t('inspector.flipVertically')
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
        <PropertyRow label={t('inspector.rowType')}>
          <SelectField
            label={t('inspector.positionType')}
            value={info.position}
            options={POSITIONS.map((p) => ({ value: p, label: p }))}
            onChange={(v) => apply({ position: v })}
          />
        </PropertyRow>
        <PropertyRow label={t('inspector.rowOrder')}>
          <StaticField>
            {info.index}
            <FieldUnit>
              {t('inspector.orderOf', { count: info.count })}
              {parentLayout(info) && ` · ${parentLayout(info)}`}
            </FieldUnit>
          </StaticField>
        </PropertyRow>
      </PropertySection>
      <PropertySection
        title={t('inspector.sectionLayout')}
        action={
          <Tooltip
            label={
              ratio !== null
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
                  ratio !== null ? 'bg-ink text-paper hover:bg-ink/85 hover:text-paper' : 'text-ink-faint',
                )}
                aria-label={t('inspector.linkSize')}
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
                label={axis === 'width' ? t('inspector.width') : t('inspector.height')}
                prefix={axis === 'width' ? 'W' : 'H'}
                value={info[axis]}
                unit="px"
                onCommit={(v) => setSize(axis, 'fixed', v)}
              />
              <SelectField
                label={axis === 'width' ? t('inspector.widthSizing') : t('inspector.heightSizing')}
                value={modeFor(axis)}
                options={sizeModes}
                onChange={(v) => setSize(axis, v)}
              />
            </div>
          ))}
        </div>
        <PropertyRow label={t('inspector.rowMinWidth')}>
          <LengthField
            label={t('inspector.minimumWidth')}
            value={info.inline['min-width'] ?? (info.minWidth === '0px' ? '' : info.minWidth)}
            placeholder="auto"
            onCommit={(v) => apply({ 'min-width': lengthValue(v) })}
          />
        </PropertyRow>
        <PropertyRow label={t('inspector.rowDisplay')}>
          <SelectField
            label={t('inspector.display')}
            value={displayValue(info)}
            options={DISPLAYS}
            onChange={(v) => apply({ display: v })}
          />
        </PropertyRow>
        {!isFlex && (
          <>
            {info.display.includes('grid') && (
              <PropertyRow label={t('inspector.rowGap')}>
                <NumberField
                  label={t('inspector.rowGapLabel')}
                  value={info.rowGap ?? 0}
                  unit="px"
                  onCommit={(v) => apply({ 'row-gap': `${Math.max(0, v)}px` })}
                />
                <NumberField
                  label={t('inspector.columnGap')}
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
        title={t('inspector.sectionAppearance')}
        action={
          <Button
            variant="bare"
            size="icon-sm"
            className="size-5 rounded-tag text-ink-faint"
            aria-label={visible ? t('inspector.hideElement') : t('inspector.showElement')}
            title={visible ? t('inspector.hideElement') : t('inspector.showElement')}
            aria-pressed={!visible}
            onClick={() => apply({ visibility: visible ? 'hidden' : 'visible' })}
          >
            {visible ? <EyeIcon size="rail" /> : <EyeClosedIcon size="rail" />}
          </Button>
        }
      >
        <div className="grid grid-cols-2 gap-1.5">
          <NumberField
            label={t('inspector.elementOpacity')}
            max={100}
            prefix={<DropletIcon size="rail" />}
            value={info.opacity === null ? null : Math.round(info.opacity * 100)}
            unit="%"
            onCommit={(v) => apply({ opacity: String(Math.min(100, Math.max(0, v)) / 100) })}
          />
          <NumberField
            label={t('inspector.cornerRadius')}
            prefix={<RadiusIcon size="rail" />}
            value={info.borderRadius}
            unit="px"
            token={chip('border-radius', info.borderRadius === null ? null : `${info.borderRadius}px`)}
            trailing={menu('border-radius', ['radius'], info.borderRadius === null ? null : `${info.borderRadius}px`)}
            onCommit={(v) => apply({ 'border-radius': `${Math.max(0, v)}px` })}
          />
        </div>
        <label className="mt-2 flex h-5 cursor-pointer items-center justify-between text-[11.5px] text-ink-soft">
          {t('inspector.clipContent')}
          <Switch
            size="sm"
            aria-label={t('inspector.clipContent')}
            className="data-[state=checked]:bg-ink"
            checked={info.clipsContent}
            onCheckedChange={(on) => apply({ overflow: on ? 'hidden' : 'visible' })}
          />
        </label>
      </PropertySection>
      <PropertySection title={t('inspector.sectionFill')}>
        {info.image && (
          <ImageFill
            key={`${frame.id}:${selector}`}
            frame={frame}
            selector={selector}
            image={info.image}
            apply={apply}
          />
        )}
        <div className="grid grid-cols-[minmax(0,1fr)_64px] gap-1.5">
          <ColorField
            label={t('inspector.fillColor')}
            value={fillAlpha === 0 && fill === '#000000' ? null : fill}
            token={chip('background-color', fillLiteral)}
            trailing={menu('background-color', ['color'], fillLiteral)}
            onCommit={(v) =>
              apply({
                'background-color': v
                  ? colorWithAlpha(v, fillAlpha === 0 && (!fill || fill === '#000000') ? 1 : fillAlpha)
                  : 'transparent',
              })
            }
          />
          <NumberField
            label={t('inspector.fillOpacity')}
            max={100}
            value={Math.round(fillAlpha * 100)}
            unit="%"
            onCommit={(v) => apply({ 'background-color': colorWithAlpha(fill ?? info.backgroundColor, v / 100) })}
          />
        </div>
      </PropertySection>
      <PropertySection title={t('inspector.sectionStroke')}>
        <div className="grid grid-cols-[minmax(0,1fr)_64px] gap-1.5">
          <ColorField
            label={t('inspector.borderColor')}
            value={borderColor}
            token={chip('border-color', strokeLiteral)}
            trailing={menu('border-color', ['color'], strokeLiteral, 'inline', strokeOn)}
            onCommit={(v) =>
              apply({ 'border-color': v, ...(v && info.borderStyle === 'none' ? { 'border-style': 'solid' } : {}) })
            }
          />
          <NumberField
            label={t('inspector.borderWidth')}
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
        {border.sides && (
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
      {info.hasText && (
        <PropertySection title={t('inspector.sectionText')}>
          <PropertyRow label={t('inspector.rowFont')}>
            <span className="group flex min-w-0 flex-1 items-center gap-1.5">
              <SelectField
                label={t('inspector.fontFamily')}
                value={bound('font-family') ? info.inline['font-family']! : mixed.fontFamily ? null : info.fontFamily}
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
              {menu('font-family', ['fontFamily'], info.fontFamily, 'beside')}
            </span>
          </PropertyRow>
          <PropertyRow label={t('inspector.rowSize')}>
            <NumberField
              label={t('inspector.fontSize')}
              value={mixed.fontSize ? null : info.fontSize}
              placeholder={t('inspector.mixed')}
              unit="px"
              token={chip('font-size', info.fontSize === null ? null : `${info.fontSize}px`)}
              trailing={menu('font-size', ['fontSize'], info.fontSize === null ? null : `${info.fontSize}px`)}
              onCommit={(v) => apply({ 'font-size': `${v}px` })}
            />
          </PropertyRow>
          <PropertyRow label={t('inspector.rowWeight')}>
            <span className="group flex min-w-0 flex-1 items-center gap-1.5">
              <SelectField
                label={t('inspector.fontWeight')}
                value={bound('font-weight') ? info.inline['font-weight']! : mixed.fontWeight ? null : info.fontWeight}
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
              {menu('font-weight', ['fontWeight'], info.fontWeight, 'beside')}
            </span>
          </PropertyRow>
          <PropertyRow label={t('inspector.rowColor')}>
            <ColorField
              value={mixed.color ? null : rgbToHex(info.color)}
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
