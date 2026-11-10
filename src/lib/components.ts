import {
  BIND_ATTR,
  COMPONENT_ATTR,
  INSTANCE_ATTR,
  OVERRIDES_ATTR,
  PART_ATTR,
  PROPS_ATTR,
  SLOT_ATTR,
  parseBindings,
  toPropName,
  type ComponentDef,
} from '../../shared/components'
import { ELEMENT_ID_ATTR, elementIdSelector } from '../../shared/elementId'
import type { Frame } from '../../shared/types'
import { api, type InstanceChangeInput } from './api'
import { recordCreate, recordUpdate, recordUpdates } from './history'
import { t } from './i18n'
import { elementPath } from './layers'
import { isLayerLocked, replaceLayerHtml } from './layerEdits'
import { useStore } from './store'
import { clientToWorld, frameAtPoint } from './commentMove'

/**
 * The editor's side of components. The server owns rendering and merging; this
 * reads what a selected element is from the frame's saved HTML and asks for
 * changes. Spec: .context/specs/components.md.
 */

export type ComponentContext =
  | {
      kind: 'main'
      def: ComponentDef
      /** the selection is the main's root, not an element inside it */
      isRoot: boolean
      selector: string
      rootSelector: string
    }
  | {
      kind: 'instance'
      def: ComponentDef
      isRoot: boolean
      selector: string
      rootSelector: string
      instanceId: string
      props: Record<string, string>
      overriddenParts: string[]
      /** the selected element's own key, when it is an element of the template */
      part?: string
    }

function parseRecord(value: string | null): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** What the selected element is to the component system, if anything. An instance wins
 *  over the main around it: that is the thing whose edits go where the person expects. */
export function componentContextOf(html: string, selector: string, defs: ComponentDef[]): ComponentContext | null {
  if (!defs.length || (!html.includes(INSTANCE_ATTR) && !html.includes(COMPONENT_ATTR))) return null
  let el: Element | null
  try {
    el = new DOMParser().parseFromString(html, 'text/html').querySelector(selector)
  } catch {
    return null
  }
  if (!el) return null
  const instance = el.closest(`[${INSTANCE_ATTR}]`)
  if (instance) {
    const def = defs.find((candidate) => candidate.id === instance.getAttribute(INSTANCE_ATTR))
    if (!def) return null
    const props: Record<string, string> = {}
    for (const [name, value] of Object.entries(parseRecord(instance.getAttribute(PROPS_ATTR)))) {
      if (typeof value === 'string') props[name] = value
    }
    return {
      kind: 'instance',
      def,
      isRoot: instance === el,
      selector,
      rootSelector: elementPath(instance),
      instanceId: instance.getAttribute(ELEMENT_ID_ATTR) ?? '',
      props,
      overriddenParts: Object.keys(parseRecord(instance.getAttribute(OVERRIDES_ATTR))),
      ...(el.getAttribute(PART_ATTR) ? { part: el.getAttribute(PART_ATTR)! } : {}),
    }
  }
  const main = el.closest(`[${COMPONENT_ATTR}]`)
  const def = main && defs.find((candidate) => candidate.id === main.getAttribute(COMPONENT_ATTR))
  if (!main || !def) return null
  return { kind: 'main', def, isRoot: main === el, selector, rootSelector: elementPath(main) }
}

/** The value a text-like prop shows when an instance has not set it: the template's own. */
export function templateValue(def: ComponentDef, prop: string): string {
  const root = new DOMParser()
    .parseFromString(`<template>${def.template}</template>`, 'text/html')
    .querySelector('template')
  for (const el of root?.content.querySelectorAll(`[${BIND_ATTR}]`) ?? []) {
    for (const binding of parseBindings(el.getAttribute(BIND_ATTR) ?? '')) {
      if (binding.prop !== prop) continue
      if (binding.target === null) return el.textContent?.trim() ?? ''
      if (!binding.target.startsWith('style.') && !binding.target.startsWith('--'))
        return el.getAttribute(binding.target) ?? ''
    }
  }
  return ''
}

function notifyFailure(error: unknown, fallback: string) {
  useStore.getState().pushNotice(error instanceof Error && error.message ? error.message : fallback)
}

/** A server-side change to one frame, adopted locally as one undo step. */
function adopt(before: Frame, after: Frame) {
  useStore.getState().upsertFrame(after)
  if (before.html !== after.html) recordUpdate(after.id, { html: before.html }, { html: after.html }, true)
}

/** Locked layers take no edits from here, the same as everywhere else on the stage. */
function refuseLocked(frame: Frame, selector: string): boolean {
  if (!isLayerLocked(frame, selector)) return false
  useStore.getState().pushNotice(t('components.locked'))
  return true
}

export async function makeComponent(frame: Frame, selector: string, name: string, replaceMatching = false) {
  if (refuseLocked(frame, selector)) return null
  const framesBefore = useStore.getState().canvas?.frames ?? []
  try {
    const { component, converted, frames } = await api.createComponent(frame.canvasId, {
      name,
      frameId: frame.id,
      element: selector,
      replaceMatching,
    })
    const items = frames.flatMap((after) => {
      const before = framesBefore.find((candidate) => candidate.id === after.id)
      useStore.getState().upsertFrame(after)
      return before && before.html !== after.html
        ? [{ frameId: after.id, before: { html: before.html }, after: { html: after.html } }]
        : []
    })
    if (items.length) recordUpdates(items)
    const linked = converted.reduce((total, entry) => total + entry.instances, 0)
    useStore
      .getState()
      .pushNotice(
        linked
          ? t('components.createdLinked', { name: component.name, count: linked })
          : t('components.created', { name: component.name }),
      )
    return component
  } catch (error) {
    notifyFailure(error, t('components.createFailed'))
    return null
  }
}

/** The name a new component starts with: the element's own, else its first class, in title case. */
function suggestedName(frame: Frame, selector: string): string {
  const el = new DOMParser().parseFromString(frame.html, 'text/html').querySelector(selector)
  const raw =
    el?.getAttribute('data-name') ??
    el?.getAttribute('class')?.split(/\s+/)[0] ??
    el?.tagName.toLowerCase() ??
    'Component'
  const base = raw
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
  const taken = new Set((useStore.getState().canvas?.components ?? []).map((def) => def.name.toLowerCase()))
  let name = base
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`
  return name
}

/** ⌘⌥K and the context menu: named from the element straight away, as renaming is one click later. */
export function promptMakeComponent(frame: Frame, selector: string) {
  void makeComponent(frame, selector, suggestedName(frame, selector))
}

export async function changeInstance(frame: Frame, change: InstanceChangeInput) {
  if (refuseLocked(frame, elementIdSelector(change.instanceId))) return
  try {
    const { frame: next, missing } = await api.changeInstances(frame.id, [change])
    if (missing.length) useStore.getState().pushNotice(t('components.changeFailed'))
    adopt(frame, next)
  } catch (error) {
    notifyFailure(error, t('components.changeFailed'))
  }
}

/** Into the selected element when there is one, else at the end of the selected frame,
 *  else onto the canvas in a frame of its own. */
export async function placeComponent(def: ComponentDef) {
  const s = useStore.getState()
  const frame = s.selectedId ? s.canvas?.frames.find((candidate) => candidate.id === s.selectedId) : undefined
  try {
    if (frame) {
      const target = s.selectedElement?.frameId === frame.id ? s.selectedElement.selector : undefined
      if (frame.locked || (target && isLayerLocked(frame, target))) {
        s.pushNotice(t('components.locked'))
        return
      }
      const { frame: next } = await api.insertInstance(frame.id, {
        component: def.id,
        ...(target ? { target, position: 'after' } : {}),
      })
      adopt(frame, next)
      return
    }
    if (!s.canvas) return
    const created = await api.createFrame(s.canvas.id, {
      name: def.name,
      ...(s.activePageId ? { pageId: s.activePageId } : {}),
      html: `<!doctype html><html><head></head><body style="margin:0"><doop-use component="${def.id}"></doop-use></body></html>`,
    })
    useStore.getState().upsertFrame(created)
    recordCreate(created)
    useStore.getState().select(created.id)
  } catch (error) {
    notifyFailure(error, t('components.placeFailed'))
  }
}

/** The drag payload a component card carries; the canvas drop reads the component id from it. */
export const COMPONENT_DRAG_TYPE = 'application/x-doop-component'

/** A component card let go over the canvas: into the frame under the pointer,
 *  or as a new frame at that point when it lands on the paper. */
export async function dropComponent(componentId: string, client: { x: number; y: number }) {
  const s = useStore.getState()
  const def = s.canvas?.components?.find((candidate) => candidate.id === componentId)
  if (!s.canvas || !def) return
  const point = clientToWorld(client.x, client.y)
  const frame = frameAtPoint(s.canvas, s.activePageId ?? null, point)
  try {
    if (frame) {
      if (frame.locked) {
        s.pushNotice(t('components.locked'))
        return
      }
      const { frame: next } = await api.insertInstance(frame.id, { component: def.id })
      adopt(frame, next)
      s.select(frame.id)
      return
    }
    const main = def.mainFrameId ? s.canvas.frames.find((candidate) => candidate.id === def.mainFrameId) : undefined
    const created = await api.createFrame(s.canvas.id, {
      name: def.name,
      ...(s.activePageId ? { pageId: s.activePageId } : {}),
      x: Math.round(point.x),
      y: Math.round(point.y),
      ...(main ? { width: main.width, height: main.height } : {}),
      html: `<!doctype html><html><head></head><body style="margin:0"><doop-use component="${def.id}"></doop-use></body></html>`,
    })
    useStore.getState().upsertFrame(created)
    recordCreate(created)
    useStore.getState().select(created.id)
  } catch (error) {
    notifyFailure(error, t('components.placeFailed'))
  }
}

/** Delete a component: its instances stay as plain markup, its main as an element. Not undoable. */
export async function removeComponent(def: ComponentDef) {
  const s = useStore.getState()
  if (!s.canvas) return
  try {
    const { instances_detached } = await api.deleteComponent(s.canvas.id, def.id)
    useStore.getState().pushNotice(t('components.deleted', { name: def.name, count: instances_detached }))
  } catch (error) {
    notifyFailure(error, t('components.deleteFailed'))
  }
}

export function goToMain(def: ComponentDef) {
  const s = useStore.getState()
  const frame = def.mainFrameId ? s.canvas?.frames.find((candidate) => candidate.id === def.mainFrameId) : undefined
  if (!frame) {
    s.pushNotice(t('components.mainGone', { name: def.name }))
    return
  }
  if (frame.pageId) s.setActivePage(frame.pageId)
  s.select(frame.id)
  s.requestFlyTo(frame.id)
}

/** Mark an element of a main as something each instance can set, or fill. */
export function exposeOnMain(frame: Frame, selector: string, attribute: typeof BIND_ATTR | typeof SLOT_ATTR): boolean {
  const doc = new DOMParser().parseFromString(frame.html, 'text/html')
  const el = doc.querySelector(selector)
  if (!el) return false
  const base = toPropName(el.getAttribute('data-name') ?? el.getAttribute('class')?.split(/\s+/).at(-1) ?? el.tagName)
  el.setAttribute(attribute, attribute === BIND_ATTR ? (el.tagName === 'IMG' ? `src:${base}` : base) : base)
  return replaceLayerHtml(frame, selector, el.outerHTML)
}
