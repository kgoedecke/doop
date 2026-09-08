import { useEffect, useMemo, useState } from 'react'
import type { Frame } from '../../shared/types'
import { useExportSelectionReady } from '../lib/exportSelection'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { deleteFrameTracked } from '../lib/history'
import { cn } from '@/lib/utils'
import { Panel, PanelBody, PanelClose, PanelHeader } from './ui/panel'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { DESIGN_SECTIONS, DESIGN_PROPERTIES } from '../lib/designProperties'
import { designSelector, layerName } from '../lib/designDocument'
import {
  commitDesignEdit,
  currentSourceElement,
  dismissUnsavedHtml,
  saveDesignPatch,
  selectDesignElement,
  selectDesignFrame,
  useDesignEditor,
} from '../lib/designEditor'
import { DesignInput, DesignSection, PropertyField, SmallAction } from './design/Controls'
import { PaintStack } from './design/PaintStack'

export function Inspector({
  frame,
  surface = 'floating',
  beside = false,
}: {
  frame: Frame
  surface?: 'floating' | 'inline'
  /* true while the Activity rail is open: the panel shifts left to sit beside it */
  beside?: boolean
}) {
  const [tab, setTab] = useState<'design' | 'html'>('design')
  const [search, setSearch] = useState('')
  const selection = useDesignEditor((s) => s.selection)
  const inspection = useDesignEditor((s) => s.inspection)
  const busy = useDesignEditor((s) => s.busy)
  const error = useDesignEditor((s) => s.error)
  const saved = useDesignEditor((s) => s.saved)
  const inlineFrameId = useDesignEditor((s) => s.inlineFrameId)
  const unsavedHtml = useDesignEditor((s) => s.unsavedHtml[frame.id])
  const stream = useStore((s) => s.streams[frame.id])
  const element = useMemo(
    () => (selection?.frameId === frame.id ? currentSourceElement(frame.html, selection) : null),
    [frame.id, frame.html, selection],
  )
  const locked = !!element?.closest('[data-doop-locked]')
  const styles = inspection?.selector === selection?.selector ? (inspection?.styles ?? {}) : {}
  const style = (key: string) => element?.style.getPropertyValue(key) || styles[key] || ''
  const commitStyle = (key: string, value: string) => {
    if (selection) void commitDesignEdit(frame.id, selection.selector, { type: 'style', values: { [key]: value } })
  }
  const isImage = element?.tagName === 'IMG' || element?.tagName === 'VIDEO'
  const isVector = element?.namespaceURI === 'http://www.w3.org/2000/svg'
  const hasText = !!element?.textContent?.trim() && !isVector
  const textLayer =
    hasText &&
    ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'SPAN', 'A', 'LABEL', 'BUTTON', 'LI'].includes(element?.tagName || '')
  const sections = DESIGN_SECTIONS.filter(
    (section) =>
      !(section.id === 'image' && !isImage) &&
      !(section.id === 'vector' && !isVector) &&
      !(['typography', 'type-details'].includes(section.id) && !hasText),
  ).sort((a, b) => {
    const order = textLayer
      ? [
          'typography',
          'size',
          'appearance',
          'fill',
          'position',
          'layout',
          'spacing',
          'stroke',
          'effects',
          'type-details',
        ]
      : [
          'size',
          'layout',
          'appearance',
          'fill',
          'position',
          'spacing',
          'stroke',
          'effects',
          'typography',
          'type-details',
        ]
    return order.indexOf(a.id) - order.indexOf(b.id)
  })
  const filtered = sections
    .flatMap((section) => section.fields)
    .filter((field) => `${field.label} ${field.key}`.toLowerCase().includes(search.toLowerCase()))

  return (
    <Panel
      surface={surface}
      aria-label="Design inspector"
      /* a small styling panel, not a full rail: bottom-aligned, sized to its
         content, and only as tall as the stage allows before its body scrolls */
      className={cn(
        surface === 'floating' && 'bottom-3 max-h-[calc(100%-24px)] w-[232px] rounded-[12px]',
        surface === 'floating' && (beside ? 'right-[324px]' : 'right-3'),
      )}
    >
      <PanelHeader className="py-2">
        <div className="flex gap-1" role="tablist" aria-label="Inspector view">
          {(['design', 'html'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              className={cn(
                'rounded-md px-2.5 py-1.5 text-[11px] uppercase tracking-wider',
                tab === value ? 'bg-paper-deep text-ink' : 'text-ink-faint',
              )}
              onClick={() => setTab(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <PanelClose label="Collapse inspector" onClick={() => useStore.getState().setInspectorOpen(false)}>
          ⇥
        </PanelClose>
      </PanelHeader>
      <PanelBody>
        {tab === 'html' ? (
          <HtmlEditor key={frame.id} frame={frame} />
        ) : (
          <>
            <div className="border-b border-line-soft px-3.5 py-3">
              <button
                className="mb-1 block max-w-full truncate text-[10px] text-ink-faint hover:text-ink"
                onClick={() => selectDesignFrame(frame.id)}
              >
                {frame.name}
              </button>
              <div className="flex items-center gap-2">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-paper-deep font-mono text-xs text-ink-soft">
                  {element ? (textLayer ? 'T' : isImage ? '▧' : '◇') : '#'}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
                  {element ? layerName(element) : selection ? 'Layer unavailable' : frame.name}
                </span>
                {element?.parentElement && element !== element.ownerDocument.body && (
                  <Button
                    variant="bare"
                    size="icon-sm"
                    aria-label="Select parent layer"
                    title="Select parent layer"
                    onClick={() => selectDesignElement(frame.id, designSelector(element.parentElement!))}
                  >
                    ↑
                  </Button>
                )}
              </div>
              {element && (
                <input
                  aria-label="Find property"
                  className="mt-3 h-8 w-full rounded-md border border-line-soft bg-paper/70 px-2.5 text-[11px] outline-none focus:border-brand"
                  placeholder="Find a property…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              )}
            </div>
            {selection && !element && (
              <p className="px-4 py-5 text-xs leading-relaxed text-ink-soft">
                This layer changed or was removed. Select it again in Layers.
              </p>
            )}
            {!selection && <FrameProperties frame={frame} />}
            {element && selection && (
              <>
                {locked && (
                  <div className="border-b border-line-soft px-3.5 py-3 text-xs text-ink-soft">
                    Layer locked.{' '}
                    <button
                      className="font-semibold text-accent-ink"
                      onClick={() =>
                        void commitDesignEdit(frame.id, designSelector(element.closest('[data-doop-locked]')!), {
                          type: 'lock',
                        })
                      }
                    >
                      Unlock
                    </button>
                  </div>
                )}
                <fieldset
                  disabled={busy || locked || !!stream || !!inlineFrameId}
                  className="min-w-0 border-0 p-0 disabled:opacity-60"
                >
                  {search ? (
                    <div className="grid grid-cols-2 gap-x-2 gap-y-2.5 p-3.5">
                      {filtered.length ? (
                        filtered.map((field) => (
                          <PropertyField
                            key={field.key}
                            field={field}
                            authored={element.style.getPropertyValue(field.key)}
                            computed={styles[field.key] || ''}
                            onCommit={commitStyle}
                          />
                        ))
                      ) : (
                        <p className="col-span-2 text-xs text-ink-faint">No matching properties.</p>
                      )}
                    </div>
                  ) : (
                    <>
                      <DesignSection id="layer" title="Layer" defaultOpen>
                        <div className="col-span-2">
                          <label className="mb-1 block text-[10px] text-ink-soft">Name</label>
                          <DesignInput
                            label="Layer name"
                            value={layerName(element)}
                            onCommit={(name) =>
                              void commitDesignEdit(frame.id, selection.selector, { type: 'rename', name })
                            }
                          />
                        </div>
                        {hasText && !element.children.length && (
                          <div className="col-span-2">
                            <label className="mb-1 block text-[10px] text-ink-soft">Content</label>
                            <DesignInput
                              label="Text content"
                              value={element.textContent || ''}
                              multiline
                              onCommit={(text) =>
                                void commitDesignEdit(frame.id, selection.selector, { type: 'text', text })
                              }
                            />
                          </div>
                        )}
                        <div className="col-span-2 flex gap-1">
                          <SmallAction
                            onClick={() => void commitDesignEdit(frame.id, selection.selector, { type: 'visibility' })}
                          >
                            {element.style.display === 'none' ? 'Show' : 'Hide'}
                          </SmallAction>
                          <SmallAction
                            onClick={() => void commitDesignEdit(frame.id, selection.selector, { type: 'lock' })}
                          >
                            Lock
                          </SmallAction>
                          <SmallAction
                            disabled={element === element.ownerDocument.body}
                            onClick={() => void commitDesignEdit(frame.id, selection.selector, { type: 'duplicate' })}
                          >
                            Duplicate
                          </SmallAction>
                        </div>
                      </DesignSection>
                      {sections.map((section) => (
                        <DesignSection
                          key={`${selection.selector}:${section.id}`}
                          id={section.id}
                          title={section.label}
                          defaultOpen={
                            section.id === 'position'
                              ? style('position') === 'absolute'
                              : section.id === 'layout'
                                ? !textLayer
                                : section.open
                          }
                        >
                          {section.id === 'fill' && (
                            <PaintStack
                              kind="fill"
                              value={style('background-image')}
                              onCommit={(value) => commitStyle('background-image', value)}
                            />
                          )}
                          {section.id === 'effects' && (
                            <PaintStack
                              kind="shadow"
                              value={style('box-shadow')}
                              onCommit={(value) => commitStyle('box-shadow', value)}
                            />
                          )}
                          {section.id === 'image' && element.tagName === 'IMG' && (
                            <>
                              <div className="col-span-2">
                                <label className="mb-1 block text-[10px] text-ink-soft">Source</label>
                                <DesignInput
                                  label="Image source"
                                  value={element.getAttribute('src') || ''}
                                  onCommit={(src) =>
                                    void commitDesignEdit(frame.id, selection.selector, { type: 'image', src })
                                  }
                                />
                              </div>
                              <div className="col-span-2">
                                <label className="mb-1 block text-[10px] text-ink-soft">Alt text</label>
                                <DesignInput
                                  label="Image alt text"
                                  value={element.getAttribute('alt') || ''}
                                  onCommit={(alt) =>
                                    void commitDesignEdit(frame.id, selection.selector, {
                                      type: 'image',
                                      src: element.getAttribute('src') || '',
                                      alt,
                                    })
                                  }
                                />
                              </div>
                            </>
                          )}
                          {section.fields.map((field) => (
                            <PropertyField
                              key={field.key}
                              field={field}
                              authored={element.style.getPropertyValue(field.key)}
                              computed={styles[field.key] || ''}
                              onCommit={commitStyle}
                            />
                          ))}
                        </DesignSection>
                      ))}
                      <DesignSection id="advanced" title="Advanced">
                        {DESIGN_PROPERTIES.filter((field) => ['transform', 'clip-path'].includes(field.key)).map(
                          (field) => (
                            <PropertyField
                              key={field.key}
                              field={field}
                              authored={element.style.getPropertyValue(field.key)}
                              computed={styles[field.key] || ''}
                              onCommit={commitStyle}
                            />
                          ),
                        )}
                        <p className="col-span-2 text-[10px] leading-relaxed text-ink-faint">
                          CSS units, calc() and var() are supported. Reset a field to use its original style.
                        </p>
                      </DesignSection>
                      {element !== element.ownerDocument.body && (
                        <div className="flex gap-1 border-b border-line-soft p-3">
                          <SmallAction
                            onClick={() =>
                              void commitDesignEdit(frame.id, selection.selector, { type: 'reorder', direction: 'up' })
                            }
                          >
                            Move up
                          </SmallAction>
                          <SmallAction
                            onClick={() =>
                              void commitDesignEdit(frame.id, selection.selector, {
                                type: 'reorder',
                                direction: 'down',
                              })
                            }
                          >
                            Move down
                          </SmallAction>
                          <Button
                            variant="bare-danger"
                            size="sm"
                            onClick={() => void commitDesignEdit(frame.id, selection.selector, { type: 'delete' })}
                          >
                            Delete layer
                          </Button>
                        </div>
                      )}
                    </>
                  )}
                </fieldset>
              </>
            )}
            <ExportSection frame={frame} />
          </>
        )}
      </PanelBody>
      <footer className="shrink-0 border-t border-line-soft px-3.5 py-2.5">
        {error ? (
          <p role="alert" className="text-[11px] leading-relaxed text-accent-ink">
            {error}
          </p>
        ) : (
          <p role="status" className="font-mono text-[10px] text-ink-faint">
            {busy
              ? 'Saving…'
              : stream
                ? 'Agent is editing…'
                : saved
                  ? 'Saved ✓'
                  : element
                    ? `${element.tagName.toLowerCase()} · edits save automatically`
                    : 'Select a layer to edit its style'}
          </p>
        )}
        {unsavedHtml !== undefined && (
          <details className="mt-2 text-[11px] text-ink-soft">
            <summary className="cursor-pointer text-ink">Recover unsaved HTML</summary>
            <p className="my-2">Copy this draft to compare it with the latest source.</p>
            <Textarea
              aria-label="Unsaved HTML"
              readOnly
              value={unsavedHtml}
              onFocus={(event) => event.currentTarget.select()}
              className="h-24 font-mono text-[10px]"
            />
            <Button variant="ghost" size="sm" onClick={() => dismissUnsavedHtml(frame.id)}>
              Dismiss draft
            </Button>
          </details>
        )}
      </footer>
    </Panel>
  )
}

function FrameProperties({ frame }: { frame: Frame }) {
  const busy = useDesignEditor((s) => s.busy)
  return (
    <fieldset disabled={busy} className="min-w-0">
      <DesignSection id="frame" title="Frame" defaultOpen>
        <div className="col-span-2">
          <label className="mb-1 block text-[10px] text-ink-soft">Name</label>
          <DesignInput
            label="Frame name"
            value={frame.name}
            onCommit={(name) => name.trim() && void saveDesignPatch(frame.id, { name: name.trim() })}
          />
        </div>
        {(['x', 'y', 'width', 'height'] as const).map((key) => (
          <div key={key}>
            <label className="mb-1 block text-[10px] capitalize text-ink-soft">{key}</label>
            <DesignInput
              label={`Frame ${key}`}
              value={String(frame[key])}
              onCommit={(value) => {
                const numeric = Number(value)
                if (!value.trim() || !Number.isFinite(numeric)) {
                  useDesignEditor.setState({ error: 'Enter a finite number.' })
                  return
                }
                void saveDesignPatch(frame.id, {
                  [key]: key === 'width' ? Math.max(120, numeric) : key === 'height' ? Math.max(80, numeric) : numeric,
                })
              }}
            />
          </div>
        ))}
        <Button className="col-span-2 mt-1" onClick={() => selectDesignElement(frame.id, 'body')}>
          Edit frame contents
        </Button>
      </DesignSection>
    </fieldset>
  )
}

function HtmlEditor({ frame }: { frame: Frame }) {
  const [draft, setDraft] = useState(frame.html)
  const [base, setBase] = useState(frame.html)
  const [dirty, setDirty] = useState(false)
  const busy = useDesignEditor((s) => s.busy)
  useEffect(() => {
    if (!dirty) {
      setDraft(frame.html)
      setBase(frame.html)
    }
  }, [frame.html, dirty])
  return (
    <div className="flex min-h-full flex-col gap-3 p-3.5">
      <p className="text-[11px] leading-relaxed text-ink-soft">Edit the frame source. Apply when ready.</p>
      <Textarea
        aria-label="Frame HTML"
        value={draft}
        spellCheck={false}
        className="min-h-[360px] flex-1 resize-y font-mono text-[11px]"
        onChange={(e) => {
          setDraft(e.target.value)
          setDirty(true)
        }}
      />
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={!dirty || busy}
          onClick={async () => {
            if (frame.html !== base) {
              useDesignEditor.setState({
                error:
                  'The source changed while you were editing. Copy your draft, then reload the source before applying.',
              })
              return
            }
            await saveDesignPatch(frame.id, { html: draft })
            if (!useDesignEditor.getState().error) setDirty(false)
          }}
        >
          Apply HTML
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            setDraft(frame.html)
            setBase(frame.html)
            setDirty(false)
            useDesignEditor.setState({ error: null })
          }}
        >
          Reload source
        </Button>
      </div>
    </div>
  )
}

function ExportSection({ frame }: { frame: Frame }) {
  const exportReady = useExportSelectionReady()
  const [copied, setCopied] = useState(false)
  return (
    <DesignSection id="export" title="Export">
      <Button size="sm" disabled={!exportReady} onClick={() => useStore.getState().openExport()}>
        Export selection…
      </Button>
      <Button
        size="sm"
        onClick={() =>
          api
            .pinReference(frame.canvasId, frame.id)
            .catch((err: Error) => useDesignEditor.setState({ error: err.message }))
        }
      >
        Pin to memory
      </Button>
      <Button
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(`${location.origin}/i/${frame.id}.png?scale=2`)
            setCopied(true)
          } catch {
            useDesignEditor.setState({ error: 'Could not copy the image URL.' })
          }
        }}
      >
        {copied ? 'Copied ✓' : 'Copy image URL'}
      </Button>
      <Button variant="bare-danger" size="sm" className="col-span-2" onClick={() => deleteFrameTracked(frame)}>
        Delete frame
      </Button>
    </DesignSection>
  )
}
