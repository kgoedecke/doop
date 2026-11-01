import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  MEASURE_ATTRIBUTE,
  measureDocument,
  type ComponentGroup,
  type LibraryComponent,
  type LibrarySnapshot,
} from '../../shared/designSystem'
import { api, errorMessage, type LibraryTarget } from './api'
import { isCanvasElement } from './drawing'
import { createCenteredFrame, DEFAULT_FRAME_SIZE } from './framePlacement'
import { recordUpdates } from './history'
import { standaloneDocument } from './layerEdits'
import { useStore } from './store'
import { t, type PlainMessageKey, type Translate } from './i18n'

/**
 * The component library a view shows (shared/designSystem.ts): fetched for
 * a canvas or a workspace, re-read whenever the room says it changed, and
 * replaced by the snapshot every write answers with.
 */
export function useLibrary(canvasId?: string, workspaceId?: string) {
  const target = useMemo<LibraryTarget | null>(
    () => (canvasId ? { canvasId } : workspaceId ? { workspaceId } : null),
    [canvasId, workspaceId],
  )
  const version = useStore((s) => s.libraryVersion)
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!target) return
    let live = true
    api
      .library(target)
      .then((next) => {
        if (!live) return
        setSnapshot(next)
        setError(null)
      })
      .catch((caught: unknown) => {
        if (live) setError(errorMessage(caught, t('library.loadFailed')))
      })
    return () => {
      live = false
    }
  }, [target, version])

  /** Runs a write and adopts the snapshot it answers with; rethrows so a form can show the error. */
  const run = useCallback(
    async (write: (target: LibraryTarget) => Promise<LibrarySnapshot>) => {
      if (!target) throw new Error('no library')
      const next = await write(target)
      setSnapshot(next)
      return next
    },
    [target],
  )

  return { target, snapshot, error, run }
}

const PRESET_GROUP_LABELS: Record<string, PlainMessageKey> = {
  buttons: 'library.groupButtons',
  collections: 'library.groupCollections',
  colors: 'library.groupColors',
  controls: 'library.groupControls',
  'data-display': 'library.groupDataDisplay',
  'date-time': 'library.groupDateTime',
  feedback: 'library.groupFeedback',
  forms: 'library.groupForms',
  layout: 'library.groupLayout',
  media: 'library.groupMedia',
  navigation: 'library.groupNavigation',
  overlays: 'library.groupOverlays',
  pickers: 'library.groupPickers',
  typography: 'library.groupTypography',
  utilities: 'library.groupUtilities',
}

/** A group's name in the interface language: presets are translated, custom groups read as typed. */
export function groupLabel(group: Pick<ComponentGroup, 'id' | 'name' | 'preset'>, translate: Translate): string {
  const key = group.preset ? PRESET_GROUP_LABELS[group.id] : undefined
  return key ? translate(key) : group.name
}

/** The markup of one instance, from the default or a named variant. */
export function instanceMarkup(component: LibraryComponent, variant?: string): string {
  return component.variants.find((v) => v.name === variant)?.html ?? component.html
}

/** Breathing room around instances that share a frame of their own (markup with several roots). */
const SHOWCASE_PADDING = 32
/** The largest a new frame grows to fit an instance; past it the instance wraps or scrolls. */
const SHOWCASE_MAX = { width: 1440, height: 1200 } as const
/** How long a measurement may wait for styles and fonts before falling back to the default size. */
const MEASURE_TIMEOUT_MS = 3000

const SHOWCASE_DOC = (markup: string) =>
  `<!doctype html>\n<html><head><meta charset="utf-8"></head><body style="margin:0;min-height:100vh;display:grid;place-items:center;padding:${SHOWCASE_PADDING}px;box-sizing:border-box">\n${markup}\n</body></html>`

type Size = { width: number; height: number }

/**
 * The size an instance renders at with the library's styles, read from an
 * off-screen document (same-origin so its layout can be read, no scripts so
 * nothing in it runs): the root element's box when the markup has one, else
 * the box around them all. Null when nothing rendered or it took too long.
 */
function measureInstance(doc: string): Promise<Size | null> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe')
    iframe.setAttribute('sandbox', 'allow-same-origin')
    iframe.setAttribute('aria-hidden', 'true')
    iframe.tabIndex = -1
    iframe.style.cssText = `position:fixed;left:-100000px;top:0;width:${SHOWCASE_MAX.width}px;height:${SHOWCASE_MAX.height}px;border:0;visibility:hidden;pointer-events:none`
    const finish = (size: Size | null) => {
      clearTimeout(timer)
      iframe.remove()
      resolve(size)
    }
    const timer = setTimeout(() => finish(null), MEASURE_TIMEOUT_MS)
    iframe.addEventListener('load', () => {
      const measured = iframe.contentDocument
      if (!measured) return finish(null)
      const read = () => {
        const wrapper = measured.querySelector(`[${MEASURE_ATTRIBUTE}]`)
        const box = wrapper?.children.length === 1 ? wrapper.firstElementChild : wrapper
        const rect = box?.getBoundingClientRect()
        finish(rect && rect.width > 0 && rect.height > 0 ? { width: rect.width, height: rect.height } : null)
      }
      measured.fonts.ready.then(read, read)
    })
    iframe.srcdoc = doc
    document.body.append(iframe)
  })
}

/**
 * The frame a new instance gets: the element alone on the canvas, with no
 * frame fill and sized to it, as a drawing or a lifted layer is; markup with
 * several roots gets a frame fitted around them instead, and anything that
 * cannot be measured the default frame.
 */
async function instanceFrame(
  globalCss: string,
  component: LibraryComponent,
  markup: string,
): Promise<{ html: string; size: Size }> {
  const measured = await measureInstance(measureDocument(globalCss, component, markup))
  if (!measured) return { html: SHOWCASE_DOC(markup), size: DEFAULT_FRAME_SIZE }
  const standalone = standaloneDocument(markup)
  const pad = standalone ? 0 : SHOWCASE_PADDING
  const fit = (content: number, max: number) => Math.min(max, Math.max(1, Math.ceil(content) + 2 * pad))
  return {
    html: standalone || SHOWCASE_DOC(markup),
    size: { width: fit(measured.width, SHOWCASE_MAX.width), height: fit(measured.height, SHOWCASE_MAX.height) },
  }
}

/**
 * Places an instance on the canvas: appended to the selected frame (one undo
 * step), else (nothing selected, or a lone canvas element) on its own in view, sized to the instance (`instanceFrame`). The
 * server stamps the component's CSS/JS into the frame on save.
 */
export async function insertComponent(
  canvasId: string,
  component: LibraryComponent,
  globalCss: string,
  variant?: string,
) {
  const markup = instanceMarkup(component, variant)
  const s = useStore.getState()
  const frame = s.canvas?.id === canvasId ? s.canvas.frames.find((f) => f.id === s.selectedId) : undefined
  if (!frame || frame.locked || frame.hidden || isCanvasElement(frame.html)) {
    const { html, size } = await instanceFrame(globalCss, component, markup)
    const created = await createCenteredFrame(canvasId, component.name, html, size)
    useStore.getState().upsertFrame(created)
    useStore.getState().select(created.id)
    return
  }
  const doc = new DOMParser().parseFromString(frame.html, 'text/html')
  const template = doc.createElement('template')
  template.innerHTML = markup
  doc.body.append(template.content)
  const html = '<!doctype html>\n' + doc.documentElement.outerHTML
  const saved = await api.updateFrame(frame.id, { html })
  recordUpdates([{ frameId: frame.id, before: { html: frame.html }, after: { html: saved.html } }])
  useStore.getState().upsertFrame(saved)
  useStore.getState().pushNotice(t('library.addedTo', { name: component.name, frame: frame.name }))
}
