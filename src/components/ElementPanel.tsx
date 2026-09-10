import { useEffect, useMemo, useRef, useState } from 'react'
import type { Frame } from '../../shared/types'
import { useStore } from '../lib/store'
import { inspectElement, onFrameReady, styleElement, type ElementInfo, type StylePatch } from '../lib/frameBridge'
import { ancestorsOf, buildLayerTree, elementHtml, type LayerNode } from '../lib/layers'
import { replaceLayerHtml } from '../lib/layerEdits'
import {
  borderSummary,
  compactBox,
  lengthValue,
  rgbToHex,
  shorthandValue,
  sizeMode,
  type SizeMode,
} from '../lib/cssValues'
import { cn } from '@/lib/utils'
import { LayerKindIcon } from './LayerKindIcon'
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
import { ArrowUpIcon } from './ui/icons'
import {
  ColorField,
  FieldUnit,
  NumberField,
  PropertyRow,
  PropertySection,
  SelectField,
  StaticField,
  TextField,
  ToggleField,
} from './ui/property-field'

const TAB_KEY = 'doop:element-panel-tab'
/* the runtime answers in a frame or two; the wait lets a streaming agent's
   chunks settle before every re-read */
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
export function ElementPanel({ frame, selector, className }: { frame: Frame; selector: string; className?: string }) {
  /* the tab sticks across elements and visits: walking the tree in HTML
     view must not snap back to Design on every row */
  const [tab, setTab] = useState<Tab>(readTab)
  const [info, setInfo] = useState<ElementInfo | null>(null)

  const tree = useMemo(() => buildLayerTree(frame.html), [frame.html])
  const node = useMemo(() => findNode(tree, selector), [tree, selector])
  const parentNode = useMemo(() => ancestorsOf(tree, selector)?.at(-1) ?? null, [tree, selector])

  /* re-read after every html change — remote edits and our own saves alike —
     and again if the frame's runtime comes up after the panel did */
  useEffect(() => {
    let live = true
    let timer: number | null = null
    const read = () => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        inspectElement(frame.id, selector)
          .then((next) => {
            if (live) setInfo(next)
          })
          .catch(console.error)
      }, INSPECT_DELAY_MS)
    }
    read()
    const off = onFrameReady(frame.id, read)
    return () => {
      live = false
      off()
      if (timer) window.clearTimeout(timer)
    }
  }, [frame.id, frame.html, selector])

  function apply(styles: StylePatch) {
    styleElement(frame.id, selector, styles)
      .then((next) => {
        if (next) setInfo(next)
      })
      .catch(console.error)
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
    const s = useStore.getState()
    s.setElementPanelOpen(false)
    s.setSelectedElement(null)
  }

  const name = node ? (node.detail ? `${node.tag}${node.detail}` : node.label) : selector.split(' > ').at(-1)
  const parentLabel = parentNode ? `${parentNode.tag}${parentNode.detail}` : 'body'

  return (
    <Panel className={cn('right-3 top-3 max-h-[calc(100%-24px)] w-[260px] transition-[right] duration-150', className)}>
      <PanelTabsRoot value={tab} onValueChange={(v) => selectTab(v === 'html' ? 'html' : 'design')}>
        <PanelHeader className="px-2.5 py-2">
          <PanelTabs>
            <PanelTab value="design">Design</PanelTab>
            <PanelTab value="html">HTML</PanelTab>
          </PanelTabs>
          <PanelClose onClick={close} />
        </PanelHeader>
        <div className="flex flex-none items-center gap-[7px] border-b border-line-soft px-3 py-2.5">
          <span className="grid size-5 flex-none place-items-center rounded-[5px] bg-paper-deep text-ink-soft">
            <LayerKindIcon kind={node?.kind ?? 'box'} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink">
            {name}
            <small className="ml-[5px] font-mono text-[9.5px] font-normal text-ink-faint">in {parentLabel}</small>
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
                <ArrowUpIcon width={12} height={12} />
              </Button>
            </Tooltip>
          )}
        </div>
        <PanelTabPanel value="design">
          <PanelBody>{info ? <DesignTab info={info} apply={apply} /> : <Waiting />}</PanelBody>
        </PanelTabPanel>
        <PanelTabPanel value="html">
          <HtmlTab key={selector} frame={frame} selector={selector} />
        </PanelTabPanel>
      </PanelTabsRoot>
    </Panel>
  )
}

function findNode(nodes: LayerNode[], selector: string): LayerNode | null {
  for (const n of nodes) {
    if (n.selector === selector) return n
    const hit = findNode(n.children, selector)
    if (hit) return hit
  }
  return null
}

function Waiting() {
  return <div className="px-3 py-6 text-center text-[12px] text-ink-faint">Reading the element…</div>
}

/* ---- Design tab ---- */

const DISPLAYS: { value: string; label: string }[] = [
  { value: 'block', label: 'block' },
  { value: 'flex-row', label: 'flex · row' },
  { value: 'flex-column', label: 'flex · column' },
  { value: 'grid', label: 'grid' },
  { value: 'inline-block', label: 'inline-block' },
  { value: 'inline-flex', label: 'inline-flex' },
  { value: 'inline', label: 'inline' },
  { value: 'none', label: 'none' },
]
const POSITIONS = ['static', 'relative', 'absolute', 'fixed', 'sticky']
const WEIGHTS = ['300', '400', '500', '600', '700', '800']
const ALIGNS = ['left', 'center', 'right', 'justify']
const SIZE_MODES: { value: SizeMode; label: string }[] = [
  { value: 'fixed', label: 'Fixed' },
  { value: 'fill', label: 'Fill' },
  { value: 'hug', label: 'Hug' },
]

function displayValue(info: ElementInfo): string {
  if (info.display === 'flex') return info.flexDirection.startsWith('column') ? 'flex-column' : 'flex-row'
  return DISPLAYS.some((d) => d.value === info.display) ? info.display : 'block'
}

function parentLayout(info: ElementInfo): string {
  const p = info.parent
  if (!p) return ''
  if (p.display === 'grid' || p.display === 'inline-grid') return 'grid'
  if (p.display === 'flex' || p.display === 'inline-flex') return `flex ${p.flexDirection.replace('-reverse', '')}`
  return p.display
}

function DesignTab({ info, apply }: { info: ElementInfo; apply: (styles: StylePatch) => void }) {
  const visible = info.visibility !== 'hidden'
  const fill = rgbToHex(info.backgroundColor)
  const borderColor = rgbToHex(info.borderColor)
  const gapMixed = info.rowGap !== info.columnGap
  const border = borderSummary(info.borderWidths)
  function setSize(axis: 'width' | 'height', mode: SizeMode) {
    if (mode === 'fixed') apply({ [axis]: `${info[axis] ?? 0}px` })
    else if (mode === 'fill') apply({ [axis]: '100%' })
    else apply({ [axis]: null })
  }
  return (
    <>
      <PropertySection title="Position">
        <PropertyRow label="Type">
          <SelectField
            value={info.position}
            options={POSITIONS.map((p) => ({ value: p, label: p }))}
            onChange={(v) => apply({ position: v === 'static' ? null : v })}
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
      <PropertySection title="Size">
        <PropertyRow label="Width">
          <NumberField value={info.width} unit="px" onCommit={(v) => apply({ width: `${v}px` })} />
          <SelectField
            className="flex-[0_0_66px]"
            value={sizeMode(info.inline['width'])}
            options={SIZE_MODES}
            onChange={(v) => setSize('width', v)}
          />
        </PropertyRow>
        <PropertyRow label="Height">
          <NumberField value={info.height} unit="px" onCommit={(v) => apply({ height: `${v}px` })} />
          <SelectField
            className="flex-[0_0_66px]"
            value={sizeMode(info.inline['height'])}
            options={SIZE_MODES}
            onChange={(v) => setSize('height', v)}
          />
        </PropertyRow>
        <PropertyRow label="Min width">
          <TextField
            value={info.inline['min-width'] ?? (info.minWidth === '0px' ? '' : info.minWidth)}
            placeholder="auto"
            onCommit={(v) => apply({ 'min-width': lengthValue(v) })}
          />
        </PropertyRow>
      </PropertySection>
      <PropertySection title="Layout">
        <PropertyRow label="Display">
          <SelectField
            value={displayValue(info)}
            options={DISPLAYS}
            onChange={(v) =>
              v.startsWith('flex-')
                ? apply({ display: 'flex', 'flex-direction': v === 'flex-column' ? 'column' : 'row' })
                : apply({ display: v, 'flex-direction': null })
            }
          />
        </PropertyRow>
        <PropertyRow label="Gap">
          <NumberField
            value={info.rowGap ?? 0}
            unit={gapMixed ? 'row' : 'px'}
            onCommit={(v) => apply({ gap: `${v}px` })}
          />
          <TextField
            className="flex-[0_0_78px]"
            value={compactBox(info.padding)}
            unit="pad"
            onCommit={(v) => apply({ padding: shorthandValue(v) })}
          />
        </PropertyRow>
      </PropertySection>
      <PropertySection title="Styles">
        <PropertyRow label="Opacity">
          <NumberField
            className="flex-[0_0_52px]"
            value={info.opacity === null ? null : Math.round(info.opacity * 100)}
            unit="%"
            onCommit={(v) => apply({ opacity: String(Math.min(100, Math.max(0, v)) / 100) })}
          />
          <input
            type="range"
            min={0}
            max={100}
            aria-label="Opacity"
            className="h-6 min-w-0 flex-1 accent-ink"
            value={info.opacity === null ? 100 : Math.round(info.opacity * 100)}
            onChange={(e) => apply({ opacity: String(Number(e.target.value) / 100) })}
          />
        </PropertyRow>
        <PropertyRow label="Visible">
          <ToggleField
            value={visible}
            labels={['Yes', 'No']}
            onChange={(on) => apply({ visibility: on ? null : 'hidden' })}
          />
        </PropertyRow>
        <PropertyRow label="Fill">
          <ColorField value={fill} onCommit={(v) => apply({ 'background-color': v ?? 'transparent' })} />
        </PropertyRow>
        <PropertyRow label="Border">
          <ColorField
            value={borderColor}
            onCommit={(v) =>
              apply({ 'border-color': v, ...(v && info.borderStyle === 'none' ? { 'border-style': 'solid' } : {}) })
            }
          />
          <NumberField
            className="flex-[0_0_78px]"
            value={border.width}
            unit={border.sides || 'px'}
            onCommit={(v) =>
              apply({
                'border-width': `${v}px`,
                ...(v > 0 && info.borderStyle === 'none' ? { 'border-style': 'solid' } : {}),
              })
            }
          />
        </PropertyRow>
        <PropertyRow label="Radius">
          <NumberField value={info.borderRadius} unit="px" onCommit={(v) => apply({ 'border-radius': `${v}px` })} />
        </PropertyRow>
      </PropertySection>
      {info.hasText && (
        <PropertySection title="Text">
          <PropertyRow label="Size">
            <NumberField value={info.fontSize} unit="px" onCommit={(v) => apply({ 'font-size': `${v}px` })} />
            <SelectField
              className="flex-[0_0_66px]"
              value={WEIGHTS.includes(info.fontWeight) ? info.fontWeight : '400'}
              options={WEIGHTS.map((w) => ({ value: w, label: w }))}
              onChange={(v) => apply({ 'font-weight': v })}
            />
          </PropertyRow>
          <PropertyRow label="Color">
            <ColorField value={rgbToHex(info.color)} onCommit={(v) => apply({ color: v })} />
          </PropertyRow>
          <PropertyRow label="Align">
            <SelectField
              value={ALIGNS.includes(info.textAlign) ? info.textAlign : 'left'}
              options={ALIGNS.map((a) => ({ value: a, label: a }))}
              onChange={(v) => apply({ 'text-align': v })}
            />
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
      variant="bare"
      className="min-h-[320px] flex-1 bg-[#17171b] p-3 font-mono text-[11.5px] leading-[1.55] text-[#e9e9ee] [tab-size:2] md:text-[11.5px]"
      value={draft}
      spellCheck={false}
      onFocus={() => setTyping(true)}
      onBlur={() => setTyping(false)}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
