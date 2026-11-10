import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import { api, ApiError } from './api'
import {
  PRIVATE_MEDIA_LIMITS,
  assertPrivateMediaCosts,
  type PrivateMediaAllowance,
  PrivateMaterializationError,
  type PrivateDocumentContext,
  type PrivateMaterialization,
} from '../../shared/privateMedia'

let epoch = 0
let actor: string | null | undefined
const blocked = new Set<string>()
const pending = new Set<AbortController>()
const listeners = new Set<() => void>()

/** Existing epoch cancellation also covers a whole export between API reads. */
export function privateMediaOperation(signal?: AbortSignal) {
  const controller = new AbortController()
  pending.add(controller)
  return {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    close: () => {
      pending.delete(controller)
      controller.abort()
    },
  }
}

export function invalidatePrivateMedia(canvasId?: string): void {
  if (canvasId) blocked.add(canvasId)
  epoch++
  for (const controller of [...pending]) controller.abort()
  for (const notify of [...listeners]) notify()
}

/** Observes the existing session owner; it does not authenticate independently. */
export function observePrivateMediaActor(id: string | null): void {
  if (actor === id) return
  actor = id
  blocked.clear()
  invalidatePrivateMedia()
}

/** Called only after the existing canvas loader has obtained fresh access. */
export function observePrivateCanvasAccess(canvasId: string): void {
  if (!blocked.delete(canvasId)) return
  invalidatePrivateMedia()
}

export function usePrivateMediaEpoch(): number {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify)
      return () => {
        listeners.delete(notify)
      }
    },
    () => epoch,
  )
}

export type PrivateMaterializer = (
  source: string,
  context: PrivateDocumentContext,
  signal?: AbortSignal,
  syntax?: 'html' | 'stylesheet' | 'value',
  remaining?: PrivateMediaAllowance,
) => Promise<PrivateMaterialization>

export const preparePrivateDocument: PrivateMaterializer = async (
  source,
  context,
  signal,
  syntax = 'html',
  remaining,
) => {
  if (blocked.has(context.canvasId)) throw new PrivateMaterializationError('aborted')
  const started = epoch
  const controller = new AbortController()
  pending.add(controller)
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  try {
    const result = await api.privateMaterialization(context, source, combined, syntax, remaining)
    if (combined.aborted || epoch !== started) throw new PrivateMaterializationError('aborted')
    if (
      !result ||
      typeof result.html !== 'string' ||
      typeof result.privateMedia !== 'boolean' ||
      !Array.isArray(result.replacements) ||
      result.replacements.length > PRIVATE_MEDIA_LIMITS.references ||
      result.replacements.some(
        (value) => !value || typeof value.inline !== 'string' || typeof value.canonical !== 'string',
      ) ||
      new TextEncoder().encode(result.html).length > PRIVATE_MEDIA_LIMITS.expandedBytes ||
      new TextEncoder().encode(JSON.stringify(result.replacements)).length > PRIVATE_MEDIA_LIMITS.replacementBytes
    )
      throw new PrivateMaterializationError('invalid')
    assertPrivateMediaCosts(result.costs)
    return result
  } catch (error) {
    if (error instanceof ApiError && [401, 403, 404].includes(error.status) && epoch === started) {
      let lostContext = true
      if (error.status === 404 && source && !combined.aborted) {
        // A missing/foreign file is not evidence of lost canvas access. Ask the
        // same current-context owner, without reading another resource or cache.
        try {
          await api.privateMaterialization(context, '', combined, 'html', {
            encodedBytes: 0,
            decodedBytes: 0,
            references: 0,
            parserWork: 0,
            expandedBytes: 0,
          })
          lostContext = false
        } catch (probe) {
          lostContext = probe instanceof ApiError && [401, 403, 404].includes(probe.status)
        }
      }
      if (lostContext && epoch === started) invalidatePrivateMedia(context.canvasId)
    }
    if (combined.aborted || epoch !== started) throw new PrivateMaterializationError('aborted')
    if (error instanceof PrivateMaterializationError) throw error
    throw new PrivateMaterializationError(
      error instanceof ApiError && error.status === 413
        ? 'limit'
        : error instanceof ApiError && error.status === 422
          ? 'unsupported'
          : 'invalid',
    )
  } finally {
    pending.delete(controller)
  }
}

/** Synthetic component fixtures can supply an explicit transport through React;
 * the application default always uses its normal authenticated API owner. */
export const PrivateMaterializationContext = createContext<PrivateMaterializer>(preparePrivateDocument)

/** Identity is checked during render too, so a changed actor/context never
 * commits the prior document while its replacement request is still pending. */
export function usePrivateDocument(source: string, context: PrivateDocumentContext | null) {
  const canvasId = context?.canvasId
  const kind = context?.kind
  const id = context?.id
  const materialize = useContext(PrivateMaterializationContext)
  const currentEpoch = usePrivateMediaEpoch()
  const [state, setState] = useState<{
    source: string
    context: PrivateDocumentContext
    epoch: number
    prepared?: PrivateMaterialization
    error?: Error
  }>()
  useEffect(() => {
    if (!canvasId || !kind || !id) return
    const requestContext = { canvasId, kind, id }
    const controller = new AbortController()
    let cancelled = false
    void materialize(source, requestContext, controller.signal)
      .then((prepared) => {
        if (!cancelled && !controller.signal.aborted)
          setState({ source, context: requestContext, epoch: currentEpoch, prepared })
      })
      .catch((error: unknown) => {
        if (!cancelled && !controller.signal.aborted)
          setState({
            source,
            context: requestContext,
            epoch: currentEpoch,
            error: error instanceof PrivateMaterializationError ? error : new PrivateMaterializationError('invalid'),
          })
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [source, canvasId, kind, id, currentEpoch, materialize])
  const matches =
    !!context &&
    state?.source === source &&
    state.epoch === currentEpoch &&
    state.context.canvasId === context.canvasId &&
    state.context.kind === context.kind &&
    state.context.id === context.id
  return {
    prepared: matches ? state.prepared : undefined,
    error: matches ? state.error : undefined,
    epoch: currentEpoch,
  }
}
