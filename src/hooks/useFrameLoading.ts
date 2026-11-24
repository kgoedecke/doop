import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { rotatedBounds } from '../../shared/frameRotation'
import type { Frame } from '../../shared/types'
import { useStore, type Viewport } from '../lib/store'
import { onFrameLoadRequest } from '../lib/frameBridge'

const BACKGROUND_LOAD_LIMIT = 8
const FOREGROUND_LOAD_LIMIT = 24
const ZOOM_OUT_SETTLE_MS = 100
const DOCUMENT_WAIT_MS = 2_000

/** Squared distance between a rotated frame's bounding box and the stage in screen pixels. */
function distanceFromStage(frame: Frame, viewport: Viewport, width: number, height: number): number {
  const box = frame.rotation ? rotatedBounds(frame, frame.rotation) : frame
  const x = Math.max(0, box.x * viewport.zoom + viewport.x - width, -(box.x + box.width) * viewport.zoom - viewport.x)
  const y = Math.max(0, box.y * viewport.zoom + viewport.y - height, -(box.y + box.height) * viewport.zoom - viewport.y)
  return x * x + y * y
}

function watchFrameLoading(stageRef: RefObject<HTMLElement>, publish: (ids: ReadonlySet<string>) => void) {
  let frames: Frame[] = []
  // A frame keeps its iframe once started. A deadline only limits how long it can hold up the queue.
  const started = new Map<string, number | null>()
  let queued = false
  let removed = false
  let raf = 0
  let status: 'initial' | 'initial-scheduled' | 'running' | 'disposed' = 'initial'
  let timeout = 0
  let resumeAfterZoom = 0
  const observer = new ResizeObserver(schedule)
  let observed: HTMLElement | null = null

  function schedule() {
    if (status === 'disposed' || (!queued && !removed)) return
    if (status === 'running') {
      if (!raf) raf = window.requestAnimationFrame(load)
      return
    }
    if (status === 'initial-scheduled') return
    status = 'initial-scheduled'
    // Stage fits the page in its layout effect before this microtask runs.
    queueMicrotask(() => {
      if (status === 'disposed') return
      status = 'running'
      load()
    })
  }

  function load() {
    raf = 0
    window.clearTimeout(timeout)
    const stage = stageRef.current
    if (!stage) return
    if (stage !== observed) {
      observer.disconnect()
      observer.observe(stage)
      observed = stage
    }
    const { clientWidth: width, clientHeight: height } = stage
    if (!width || !height) return

    const now = performance.now()
    if (now < resumeAfterZoom) {
      timeout = window.setTimeout(schedule, resumeAfterZoom - now)
      return
    }

    const { viewport, selectedIds, selectedElement } = useStore.getState()
    const selected = new Set(selectedIds)
    const foreground: Frame[] = []
    const background: { frame: Frame; distance: number }[] = []
    let nextDeadline = Infinity
    let loading = 0
    let priorityLoading = 0

    for (const frame of frames) {
      if (frame.hidden) continue
      const deadline = started.get(frame.id)
      if (deadline === null || (deadline !== undefined && deadline <= now)) continue

      const distance = distanceFromStage(frame, viewport, width, height)
      const priority = distance === 0 || selected.has(frame.id) || frame.id === selectedElement?.frameId
      if (deadline !== undefined) {
        nextDeadline = Math.min(nextDeadline, deadline)
        loading++
        if (priority) priorityLoading++
      } else if (priority) foreground.push(frame)
      else background.push({ frame, distance })
    }

    // Keep visible frames moving even if offscreen documents are still booting.
    const backgroundCapacity = priorityLoading ? 0 : BACKGROUND_LOAD_LIMIT - loading
    const batch = foreground.length
      ? foreground.slice(0, Math.max(0, FOREGROUND_LOAD_LIMIT - priorityLoading))
      : backgroundCapacity > 0
        ? background
            .sort((a, b) => a.distance - b.distance)
            .slice(0, backgroundCapacity)
            .map(({ frame }) => frame)
        : []
    const deadline = now + DOCUMENT_WAIT_MS
    for (const frame of batch) started.set(frame.id, deadline)
    if (batch.length || removed) {
      publish(new Set(started.keys()))
      removed = false
    }

    queued = foreground.length + background.length > batch.length
    if (queued) timeout = window.setTimeout(schedule, Math.min(nextDeadline, deadline) - now)
  }

  const stop = useStore.subscribe((state, previous) => {
    if (queued && status === 'running' && state.viewport.zoom < previous.viewport.zoom) {
      // A zoom-out can expose the whole board. Let the camera move before booting those iframes.
      resumeAfterZoom = performance.now() + ZOOM_OUT_SETTLE_MS
    }
    if (
      state.viewport !== previous.viewport ||
      state.selectedIds !== previous.selectedIds ||
      state.selectedElement !== previous.selectedElement
    ) {
      schedule()
    }
  })

  const stopRequests = onFrameLoadRequest((id) => {
    if (!frames.some((frame) => frame.id === id && !frame.hidden)) return false
    if (!started.has(id)) {
      started.set(id, performance.now() + DOCUMENT_WAIT_MS)
      publish(new Set(started.keys()))
      schedule()
    }
    return true
  })

  return {
    setFrames(next: Frame[]) {
      frames = next
      const ids = new Set(next.map(({ id }) => id))
      for (const id of started.keys()) {
        if (ids.has(id)) continue
        started.delete(id)
        removed = true
      }
      queued = next.some((frame) => !frame.hidden && !started.has(frame.id))
      schedule()
    },
    ready(id: string) {
      const deadline = started.get(id)
      if (deadline === undefined || deadline === null) return
      started.set(id, null)
      schedule()
    },
    dispose() {
      status = 'disposed'
      stop()
      stopRequests()
      observer.disconnect()
      window.cancelAnimationFrame(raf)
      window.clearTimeout(timeout)
    },
  }
}

/** Run after Stage sets the camera on page entry. Panning only renders React when it starts more iframes. */
export function useFrameLoading(stage: RefObject<HTMLElement>, frames: Frame[]) {
  const loader = useRef<ReturnType<typeof watchFrameLoading> | null>(null)
  const [started, setStarted] = useState<ReadonlySet<string>>(() => new Set())
  useLayoutEffect(() => {
    const watch = watchFrameLoading(stage, setStarted)
    loader.current = watch
    return () => {
      loader.current = null
      watch.dispose()
    }
  }, [stage])
  useLayoutEffect(() => {
    loader.current?.setFrames(frames)
  }, [frames])

  const onDocumentReady = useCallback((id: string) => loader.current?.ready(id), [])
  return { started, onDocumentReady }
}
